# @spfn/core 프록시↔백엔드 신뢰 검증 + Origin 검증 (클라이언트 출처 강화)

> 출처: 보안 설계 논의(2026-06-24). 백엔드가 모바일 때문에 공개망에 노출돼야 하는 전제 위에서,
> 코드/아키텍처 레벨로 클라이언트 출처를 검증하는 1차 작업.
> 모바일 client attestation은 이 작업의 후속(메모리: mobile-attestation-followup).

## 배경 (왜)

백엔드(`SPFN_API_URL`, 기본 `http://localhost:8790`)는 모바일 앱 때문에 공개망에 떠야 한다.
지금은 client-signed JWT 인증만으로 막고 있다. 위협을 둘로 가른다.

- **위협 A — 미인증 외부인.** 남의 데이터 접근, login/register 무차별, 프록시를 건너뛴 백엔드 직접 타격.
  → 막을 수 있고, 막아야 한다. 이 작업의 대상.
- **위협 B — 인증된 본인의 비공식 클라이언트 자동화.** 자기 계정으로 직접 짠 스크립트 호출.
  → 근본적으로 원천 차단 불가. "충분히 비싸게"의 게임. 웹은 한계가 명확(아래), 모바일은 후속 attestation.

현재 구조에서 정상 Next.js 앱은 `/api/rpc/[routeName]` 프록시(`packages/core/src/nextjs/proxy/rpc.ts`)를
거쳐 백엔드로 간다. 프록시가 routeName→{method,path}를 resolve해 forward하므로 클라는 실제 백엔드 path를 모른다.
하지만 백엔드는 "이 요청이 우리 프록시를 거쳐 왔는가"를 검증하지 않는다 → JWT만 있으면 백엔드 직접 호출 가능.

## 범위

### A. 프록시→백엔드 HMAC 서명 (핵심)

프록시가 백엔드로 forward할 때 요청에 서명을 실어, 백엔드가 "정상 프록시 경유"를 검증한다.

- **서명 대상**: `method + path + query + timestamp + nonce + bodyHash + clientIp`. clientIp는
  `x-spfn-proxy-client-ip` 값(없으면 `''`) — 서명 버전 2(`x-spfn-proxy-signature-version: 2`, #363).
  버전 1(clientIp 없음)은 0.4.x 동안만 검증하고 그 주소는 무시한다. path·query는
  **wire 표현**(프록시가 보내는 raw request-target). 백엔드는 디코드된 `c.req.path`가 아니라
  `new URL(c.req.url).pathname`·`.search`로 재구성해 바이트를 일치시킨다(인코딩 드리프트 방지).
  query를 서명에 넣어야 캡처한 서명을 쿼리만 바꿔 재전송하는 걸 막는다.
- **bodyHash**: multipart(formData)만 제외(대용량·업로드 성능). 그 외 *모든* content-type의 body는
  항상 SHA-256으로 바인딩 — content-type을 비-JSON으로 바꿔 body를 서명에서 푸는 우회를 차단. SSE는 응답 스트리밍이라 무관.
- **헤더**: `X-SPFN-Proxy-Signature`, `X-SPFN-Proxy-Timestamp`, `X-SPFN-Proxy-Nonce`, `X-SPFN-Proxy-Key-Id`.
- **알고리즘**: HMAC-SHA256. 요청당 마이크로초 단위 — 프록시↔백엔드 왕복 대비 무시 가능.
- **공유 시크릿**: `SPFN_PROXY_SECRET`을 프록시·백엔드 양쪽에 주입(아래 E·F 참고).
  값은 로그/출력 노출 금지(키 이름만). k8s secret으로 양쪽 deployment 주입 권장.

**프록시 측 끼우는 자리**: `rpc.ts` `handleRpc`의 fetch 직전(현재 ~371행).
모든 인터셉터가 헤더·body를 만진 *후* fetchOptions가 최종 확정된 시점이어야
서명한 body와 실제 전송 body가 일치한다(인터셉터가 body 변경 가능, ~365행).
`RpcProxyConfig`에 시크릿/on-off 옵션 추가.

**백엔드 측 검증**: 라우트 등록 전 전역 미들웨어(파이프라인 4단계, CORS 다음).
서명 재계산 일치 + timestamp 윈도우(기본 30s) 검사로 캡처-재전송 차단.
통과 시 컨텍스트에 `clientType: 'web'` 주입 → 라우트가 출처를 알 수 있고,
이 자리가 후속 attestation 레벨 체크가 들어올 지점.

- **fail-closed**: `strict`인데 키가 미설정이면 미들웨어 생성 시 throw(서버 시작 실패) — 검증 불가 상태로
  문이 열린 채 뜨지 않게. `tag`는 관측 모드라 키 없으면 전부 `untrusted` 태깅하고 통과(경고).
- **자동 skip**: health·SSE 스트림(`/events/stream`)·WS 경로는 서명 없이 통과(EventSource는 커스텀 헤더 불가).
  단 SSE **토큰(POST)** 은 프록시를 거치고 자격증명을 발급하므로 skip하지 않고 검증한다.
  진짜 CORS preflight(`Access-Control-Request-Method` 동반)만 CORS 레이어(`cors()`) 영역으로 *가장 먼저*
  면제한다(origin 검사도 안 함). 그 외 OPTIONS(드문 OPTIONS-as-API)는 정상 검증을 거치므로 우회가 아니다.
  허용되지 않은 origin은 preflight를 통과해도 뒤따르는 실제 요청에서 origin+서명으로 차단되므로 데이터 노출이 없다.
- **모드별 차이**: origin·서명·nonce·body-cap 게이트는 *양 모드에서 평가*하고 enforcement만 다르다 —
  strict는 거부(403/413), tag는 `clientType='untrusted'`로 태깅하고 통과. 그래서 tag는 strict가 무엇을
  거부할지 정확히 관측한다(지표 왜곡 없음). OPTIONS는 origin 검사 없이 `clientType='untrusted'`로만 태깅한다.
- **body-cap**: `maxBodyBytes` 설정 시 body를 *스트리밍으로 측정*하다 초과하면 중단·413. Content-Length는
  신뢰하지 않으므로 누락·chunked·과소보고로 우회할 수 없다. multipart는 비대상. 미설정이면 무제한.
- **base path**: 프록시는 라우트 상대 경로를 서명하므로 `SPFN_API_URL`에 백엔드가 유지하는 base path가 있으면
  서명이 어긋난다. 프록시 부팅 시 경고를 남기며, ingress가 prefix를 strip하는 구성을 전제로 한다.

### B. Origin allowlist 검증

- 브라우저 안 JS는 `Origin`/`Referer`를 위조 못 함(forbidden headers). 위조 가능한 건 브라우저 밖(curl/서버)인데
  거기선 세션 쿠키(HttpOnly + SameSite=strict, 이미 적용됨)가 안 실려 인증 실패.
- 미인증 cross-origin 요청을 입구에서 떨구는 저비용 미들웨어. 허용 origin 목록을 config/env로.
- HMAC 미들웨어와 같은 전역 단계에 함께 등록.

### C. nonce replay 차단 (옵셔널, Redis)

- timestamp 윈도우만으로는 같은 윈도우 내 재전송이 남는다. 완전 차단은 nonce를 Redis에 짧은 TTL로 캐싱,
  한 번 쓴 nonce 거부.
- **옵셔널**: 모두가 Redis를 쓰진 않음. `CACHE_URL`(SSE/토큰 store와 동일 컨벤션) 있을 때만 활성,
  없으면 timestamp 윈도우로만 동작. 옵션 플래그로 민감 라우트에만 켤 수도.
- **degrade**: store가 잠깐 불통이면 timestamp 윈도우로 폴백(통과 + 경고). Redis blip이 정상 트래픽을
  500으로 만들지 않게 — replay 하드닝이 가용성을 떨어뜨리면 안 됨.

### D. enforcement 모드 (config 옵션)

프레임워크라 기본값이 기존 앱을 깨면 안 된다.

- `off` (기본): 검증 안 함. 기존 호환.
- `tag`: 서명/origin 검증해 `clientType` 등 컨텍스트만 태깅, 실패해도 통과(관측 우선).
- `strict`: 검증 실패 시 거부.
- 운영 권장: 프로덕션 트래픽 받는 중이면 `tag`로 관측 후 `strict` 승격, 신규면 바로 `strict`.

### E. 키 로테이션 (무중단)

두 독립 프로세스(Next 프록시·SPFN 백엔드)가 같은 키를 공유하므로, 단일 시크릿을 한 번에
교체하면 롤링 배포 중 파드가 섞여 검증이 깨진다. 그래서 **키 ID + grace 키셋**으로 푼다.

- **표현**: 시크릿은 `<keyId>:<secret>` (콜론 없으면 keyId=`default`, 하위호환).
- **프록시**: active 키(`SPFN_PROXY_SECRET`)로만 서명, `X-SPFN-Proxy-Key-Id` 헤더로 keyId 전달.
- **백엔드**: keyId로 키셋에서 검증 키 선택. 키셋 = active(`SPFN_PROXY_SECRET`) +
  grace(`SPFN_PROXY_SECRET_PREVIOUS`, 콤마로 여럿). keyId collision은 active 우선.
- **무중단 절차**: ① 백엔드 `active=v2, previous=v1` 배포(둘 다 검증) → ② 프록시 `active=v2`
  배포 → ③ grace 지나면 백엔드 `previous`에서 v1 제거. 어느 시점에도 깨지는 요청 없음.
- **자동화 확장**: 이 키셋이 토대. GCP Secret Manager가 env를 주기적으로 굴리고 양쪽이 짧은
  TTL로 재로드하면 완전 자동 로테이션. (시간 기반 파생은 master 유출 시 무력이라 비채택.)

### F. .env 배치 (react2shell 맥락)

react2shell(CVE-2025-55182, RSC RCE/env 유출) 때문에 SPFN은 Next가 읽을 필요 없는 시크릿을
`.env.server`로 격리한다(Next process.env에 안 올림 → RCE로도 안 샘). 이 분리에 맞춰:

- **`SPFN_PROXY_SECRET`(active)** → `.env.local`. 프록시가 *서명을 만들려면* Next가 알아야 해서
  `.env.server` 격리 불가(거기 두면 프록시가 못 읽어 서명 자체를 안 붙임). `nextjs: true` +
  `sensitive: true`라 CLI가 `.env.local`로 분류(서버 런타임만, 브라우저 미노출). 백엔드는 loadEnv가
  `.env.local`도 읽으므로 양쪽이 본다.
- **`SPFN_PROXY_SECRET_PREVIOUS`(grace)** → `.env.server`. 백엔드 검증 전용(프록시는 previous로
  서명 안 함)이라 Next에 노출할 이유가 없음. `nextjs: false`.
- **한계(정직)**: active는 Next가 들 수밖에 없어 react2shell류 노출을 못 피한다. 다만 (1) 이 시크릿이
  새도 무력화되는 건 "프록시 우회 차단"뿐 — JWT 인증은 독립이라 데이터 접근은 막힘. (2) Next가 RCE로
  뚫리면 시크릿 유출과 무관하게 공격자가 Next 안에서 백엔드를 직접 호출 가능 → 격리해도 이득 적음.
  실질 방어는 **Next 패치 유지 + 정기 로테이션**(E).
- 배포(k8s)에선 파일 무관 — 양쪽 deployment env로 주입. previous는 백엔드 pod에만.

## 웹의 한계 (정직하게 — 문서에 박아둘 것)

- 브라우저 안 + 우리 도메인(정상 앱 OR DevTools 콘솔 붙여넣기)은 Origin·쿠키·모든 헤더가 동일 →
  네트워크 레벨에서 **구분 불가능.** 콘솔 붙여넣기는 막을 수 없고 비용만 올린다(CSRF double-submit,
  커스텀 헤더, self-XSS 콘솔 경고문 등). 단 콘솔 코드는 *본인 계정*에만 닿음(남의 쿠키 없음) → 위협 B.
- 브라우저 안 + 다른 도메인(악성 사이트 cross-origin)은 Origin이 그 도메인으로 박히고(위조 불가)
  쿠키도 SameSite=strict로 안 실려 막힘 → B로 차단.
- 브라우저 밖(curl/서버)은 Origin 위조 가능하나 쿠키 없어 본인 계정 외 불가.
- 결론: "외부 흉내 / cross-origin"은 A+B로 잡힘. "콘솔 붙여넣기"는 못 잡음 → 모바일 attestation이 필요한 이유.

## 모바일 attestation (후속, 별도 작업)

App Attest(iOS) / Play Integrity(Android). B 미들웨어에 "또는 유효한 attestation" OR 조건 추가 형태로 자람.
상세: 메모리 `mobile-attestation-followup`.

## 수용 기준

- 프록시 경유 정상 요청: 백엔드가 서명 검증 통과, `clientType=web` 태깅.
- 프록시 우회 백엔드 직접 호출(서명 없음): `strict`에서 거부.
- Origin 미허용 cross-origin: 거부.
- Redis 미설정: nonce 없이 timestamp 윈도우로 정상 동작.
- `off`/기존 앱: 동작 변화 없음(호환).
- formData 업로드 성능: bodyHash 제외로 회귀 없음.

## 관련 파일

- `packages/core/src/nextjs/proxy/rpc.ts` (프록시 forward, fetch 직전 서명 자리 ~371행)
- `packages/core/src/nextjs/proxy/types.ts` (`RpcProxyConfig`)
- `packages/core/src/nextjs/proxy/helpers.ts` (`buildProxyHeaders` 등)
- 백엔드 미들웨어 등록부 (server config `config.use[]`, 파이프라인 4단계)
- 쿠키 설정 참고: `packages/auth` session-helpers (SameSite=strict, HttpOnly 이미 적용)
- nonce store 참고: `CacheTokenStore`(Redis transport 패턴)
