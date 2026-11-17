# @spfn/notification 패키지 설계

## 개요

다양한 채널(이메일, SMS, Slack, Push 등)을 통한 알림 발송 및 관리를 위한 통합 모듈

## 핵심 기능

1. **다중 채널 지원**: Email, SMS, Slack, Push (확장 가능)
2. **발송 방식**: 단건, 다건, 예약, 배치 (기존 `@spfn/core/job` 활용)
3. **템플릿 시스템**: 치환변수 지원, 채널별 포맷
4. **Provider 패턴**: 채널별 다양한 provider 지원

---

## 디렉토리 구조

```
packages/notification/
├── src/
│   ├── index.ts                    # Public exports (types)
│   ├── server.ts                   # Server-side exports
│   │
│   ├── config/
│   │   ├── index.ts
│   │   └── schema.ts               # Environment schema
│   │
│   ├── channels/                   # 채널별 구현
│   │   ├── index.ts
│   │   ├── types.ts                # Channel 공통 타입
│   │   ├── concurrency.ts          # runWithConcurrency 유틸
│   │   │
│   │   ├── email/
│   │   │   ├── index.ts
│   │   │   ├── types.ts
│   │   │   └── providers/
│   │   │       ├── aws-ses.ts
│   │   │       ├── sendgrid.ts     (추후)
│   │   │       └── smtp.ts         (추후)
│   │   │
│   │   ├── sms/
│   │   │   ├── index.ts
│   │   │   ├── types.ts
│   │   │   └── providers/
│   │   │       ├── aws-sns.ts
│   │   │       └── twilio.ts       (추후)
│   │   │
│   │   ├── slack/
│   │   │   ├── index.ts
│   │   │   ├── types.ts
│   │   │   └── providers/
│   │   │       └── webhook.ts
│   │   │
│   │   └── push/                   (추후)
│   │       └── ...
│   │
│   ├── templates/                  # 템플릿 시스템
│   │   ├── index.ts
│   │   ├── types.ts
│   │   ├── registry.ts             # 템플릿 등록/조회
│   │   ├── renderer.ts             # 치환변수 처리
│   │   └── builtin/                # 기본 제공 템플릿
│   │       ├── verification-code.ts
│   │       ├── welcome.ts
│   │       └── password-reset.ts
│   │
│   ├── jobs/                       # @spfn/core/job 활용
│   │   ├── index.ts
│   │   ├── router.ts               # notificationJobRouter
│   │   ├── send-scheduled-email.ts # 예약 이메일 발송 job
│   │   ├── send-scheduled-sms.ts   # 예약 SMS 발송 job
│   │   ├── send-bulk-email-item.ts # 분산 벌크 이메일 item job (batchSize: 50)
│   │   ├── send-bulk-sms-item.ts   # 분산 벌크 SMS item job (batchSize: 50)
│   │   └── send-bulk-slack-item.ts # 분산 벌크 Slack item job (batchSize: 50)
│   │
│   ├── entities/                   # DB 스키마 (발송 이력)
│   │   ├── index.ts
│   │   └── notifications.ts        # 발송 이력
│   │
│   └── services/
│       └── notification.service.ts # 핵심 발송 서비스
│
├── migrations/
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

---

## 핵심 API 설계

### 1. 단건 발송 (동기)

```typescript
import { sendEmail, sendSMS, sendSlack } from '@spfn/notification/server';

// 즉시 발송
await sendEmail({
    to: 'user@example.com',
    template: 'verification-code',
    data: { code: '123456' }
});

await sendSMS({
    to: '+821012345678',
    template: 'verification-code',
    data: { code: '123456' }
});

await sendSlack({
    channel: '#alerts',
    text: '새 주문이 들어왔습니다'
});
```

### 2. 예약 발송 (@spfn/core/job 활용)

```typescript
import { sendEmailJob } from '@spfn/notification/server';

// 1시간 후 발송
await sendEmailJob.send(
    {
        to: 'user@example.com',
        template: 'reminder',
        data: { eventName: '미팅' }
    },
    { startAfter: '1h' }
);

// 특정 시간에 발송
await sendEmailJob.send(
    { to: 'user@example.com', template: 'birthday', data: { name: '홍길동' } },
    { startAfter: new Date('2024-12-25 09:00:00') }
);
```

### 3. 이벤트 기반 발송 (@spfn/core/event 활용)

```typescript
// 앱에서 이벤트 정의
import { defineEvent } from '@spfn/core/event';
import { job } from '@spfn/core/job';
import { sendEmail } from '@spfn/notification/server';

export const userCreated = defineEvent('user.created', Type.Object({
    userId: Type.String(),
    email: Type.String(),
    name: Type.String(),
}));

// 이벤트 구독 job 정의
export const sendWelcomeEmailJob = job('send-welcome-email')
    .on(userCreated)
    .handler(async (payload) => {
        await sendEmail({
            to: payload.email,
            template: 'welcome',
            data: { name: payload.name }
        });
    });

// 이벤트 발생 시 자동 발송
await userCreated.emit({ userId: '123', email: 'user@example.com', name: '홍길동' });
```

### 4. 다건 발송

```typescript
import { sendEmailBulk } from '@spfn/notification/server';

// In-process 병렬 발송 (기본, concurrency 10)
await sendEmailBulk([
    { to: 'user1@example.com', template: 'welcome', data: { name: '홍길동' } },
    { to: 'user2@example.com', template: 'welcome', data: { name: '김철수' } },
], { concurrency: 20 });

// 분산 발송 (pg-boss 경유, 멀티 인스턴스 처리)
await sendEmailBulk(items, { distributed: true });
```

**분산 모드 흐름:**
```
호출 인스턴스: validate → batch INSERT records → tracking → boss.insert(N jobs) → return
인스턴스 A: boss.work(batchSize:50) → 50건 fetch → 50건 병렬 발송
인스턴스 B: boss.work(batchSize:50) → 50건 fetch → 50건 병렬 발송
...자동 분산, 실패 건 개별 재시도 (pg-boss retryLimit)
```

### 5. 배치 발송 (cron job)

```typescript
import { job } from '@spfn/core/job';
import { sendEmailBulk } from '@spfn/notification/server';

// 매일 오전 9시 마케팅 이메일 (분산 처리)
export const dailyMarketingJob = job('daily-marketing')
    .cron('0 9 * * *')
    .handler(async () => {
        const users = await getActiveUsers();

        await sendEmailBulk(
            users.map(user => ({
                to: user.email,
                template: 'daily-digest',
                data: { name: user.name, content: getDailyContent() }
            })),
            { distributed: true }
        );
    });
```

---

## 템플릿 시스템

### 1. 템플릿 등록

```typescript
import { registerTemplate } from '@spfn/notification/server';

registerTemplate({
    name: 'order-confirmation',
    channels: ['email', 'sms'],

    email: {
        subject: '[{{appName}}] 주문이 완료되었습니다',
        html: `
            <h1>주문 확인</h1>
            <p>{{userName}}님, 주문번호 {{orderId}} 주문이 완료되었습니다.</p>
            <p>결제금액: {{amount | currency}}원</p>
        `,
        text: '{{userName}}님, 주문번호 {{orderId}} 주문완료. 금액: {{amount}}원'
    },

    sms: {
        message: '[{{appName}}] {{userName}}님 주문완료 #{{orderId}} {{amount | currency}}원'
    }
});
```

### 2. 치환변수 문법

```
{{variable}}              - 기본 치환
{{variable | uppercase}}  - 대문자 변환
{{variable | lowercase}}  - 소문자 변환
{{variable | currency}}   - 통화 포맷 (1,000)
{{variable | date}}       - 날짜 포맷
{{variable | date:YYYY-MM-DD}} - 커스텀 날짜 포맷
{{variable | truncate:20}} - 글자수 제한
```

### 3. 기본 제공 템플릿

| 이름 | 채널 | 용도 |
|------|------|------|
| `verification-code` | email, sms | 인증 코드 |
| `welcome` | email | 회원가입 환영 |
| `password-reset` | email | 비밀번호 재설정 |
| `invitation` | email | 초대 |

---

## 채널 타입 정의

### 공통 인터페이스

```typescript
// channels/types.ts

export interface ChannelProvider<TSendParams, TResult>
{
    name: string;
    send(params: TSendParams): Promise<TResult>;
}

export interface SendResult
{
    success: boolean;
    messageId?: string;
    error?: string;
}
```

### Email

```typescript
// channels/email/types.ts

export interface SendEmailParams
{
    to: string | string[];
    subject?: string;          // 템플릿 사용 시 생략 가능
    template?: string;
    data?: Record<string, unknown>;
    text?: string;             // 직접 지정
    html?: string;             // 직접 지정
}

export interface EmailProvider extends ChannelProvider<SendEmailParams, SendResult>
{
    name: 'aws-ses' | 'sendgrid' | 'smtp' | string;
}
```

### SMS

```typescript
// channels/sms/types.ts

export interface SendSMSParams
{
    to: string | string[];      // E.164 format
    template?: string;
    data?: Record<string, unknown>;
    message?: string;           // 직접 지정
}

export interface SMSProvider extends ChannelProvider<SendSMSParams, SendResult>
{
    name: 'aws-sns' | 'twilio' | string;
}
```

### Slack

```typescript
// channels/slack/types.ts

export interface SendSlackParams
{
    channel: string;            // #channel or webhook URL
    text?: string;
    template?: string;
    data?: Record<string, unknown>;
    blocks?: SlackBlock[];      // Slack Block Kit
}
```

---

## Provider 설정

### 환경변수

```bash
# Email
SPFN_NOTIFICATION_EMAIL_PROVIDER=aws-ses
SPFN_NOTIFICATION_EMAIL_FROM=noreply@example.com

# AWS SES
AWS_REGION=ap-northeast-2
AWS_ACCESS_KEY_ID=xxx
AWS_SECRET_ACCESS_KEY=xxx

# SMS
SPFN_NOTIFICATION_SMS_PROVIDER=aws-sns

# Slack
SPFN_NOTIFICATION_SLACK_WEBHOOK_URL=https://hooks.slack.com/...
```

### 코드 설정

```typescript
import { configureNotification } from '@spfn/notification/server';

configureNotification({
    email: {
        provider: 'aws-ses',
        from: 'noreply@example.com',
        replyTo: 'support@example.com'
    },
    sms: {
        provider: 'aws-sns',
        defaultCountryCode: '+82'
    },
    slack: {
        webhookUrl: process.env.SLACK_WEBHOOK_URL
    },
    defaults: {
        appName: 'MyApp'
    }
});
```

---

## Entity 스키마 (발송 이력)

All tables are created in the `spfn_notification` schema.

```typescript
// entities/schema.ts
export const notificationSchema = createSchema('@spfn/notification');

// entities/notifications.ts
export const notifications = notificationSchema.table('history', {
    id: id(),

    channel: text('channel', {
        enum: ['email', 'sms', 'slack', 'push']
    }).notNull(),

    recipient: text('recipient').notNull(),

    templateName: text('template_name'),
    templateData: jsonb('template_data'),

    subject: text('subject'),
    content: text('content'),

    status: text('status', {
        enum: ['scheduled', 'pending', 'sent', 'failed', 'cancelled']
    }).notNull().default('pending'),

    providerMessageId: text('provider_message_id'),
    errorMessage: text('error_message'),

    scheduledAt: utcTimestamp('scheduled_at'),
    sentAt: utcTimestamp('sent_at'),

    jobId: text('job_id'),          // pg-boss job ID
    batchId: text('batch_id'),      // Bulk operation ID

    referenceType: text('reference_type'),
    referenceId: text('reference_id'),

    ...timestamps()
});
```

---

## Export 구조

```json
{
    ".": {
        "types": "./dist/index.d.ts",
        "import": "./dist/index.js"
    },
    "./server": {
        "types": "./dist/server.d.ts",
        "import": "./dist/server.js"
    },
    "./config": {
        "types": "./dist/config/index.d.ts",
        "import": "./dist/config/index.js"
    }
}
```

---

## 의존성

```json
{
    "dependencies": {
        "@spfn/core": "workspace:*"
    },
    "peerDependencies": {
        "@aws-sdk/client-sesv2": "^3.1074.0",
        "@aws-sdk/client-sns": "^3.1074.0"
    },
    "peerDependenciesMeta": {
        "@aws-sdk/client-sesv2": { "optional": true },
        "@aws-sdk/client-sns": { "optional": true }
    }
}
```

---

## @spfn/auth 연동

```typescript
// @spfn/auth 에서 notification 사용
import { sendEmail, sendSMS } from '@spfn/notification/server';

// 인증 코드 발송 (기존 로직 대체)
await sendEmail({
    to: user.email,
    template: 'verification-code',
    data: { code, expiresInMinutes: 5 }
});

await sendSMS({
    to: user.phone,
    template: 'verification-code',
    data: { code }
});
```

---

## 구현 우선순위

### Phase 1 (MVP)
- [ ] 패키지 기본 구조 생성
- [ ] Email 채널 (AWS SES provider)
- [ ] SMS 채널 (AWS SNS provider)
- [ ] 단건 발송 API (`sendEmail`, `sendSMS`)
- [ ] 템플릿 시스템 (치환변수)
- [ ] 기본 템플릿 (verification-code, welcome)

### Phase 2
- [ ] 다건 발송 (`sendEmailBulk`)
- [ ] 발송 이력 Entity
- [ ] Slack 채널 (webhook)
- [ ] @spfn/auth에서 notification으로 마이그레이션

### Phase 3
- [ ] Push 채널 (FCM, Web Push)
- [ ] 추가 provider (SendGrid, Twilio)
- [ ] 발송 통계 API
