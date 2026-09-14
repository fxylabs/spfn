# @spfn/cms

Type-safe content management for Next.js. Labels are declared in code and stored in your
own PostgreSQL database: the declaration gives autocomplete and a compile-time check, and
the stored values stay editable at runtime with drafts, versions and an audit trail. The
database is synchronized from the declarations on server startup.

## What you get

- 🎯 **Type-safe labels** - Full TypeScript support with autocomplete
- 🔄 **Auto-sync** - Database synchronization on server startup
- 🌐 **Multi-language** - Type-checked locale support
- 🍪 **Smart locale detection** - Cookie-based with automatic fallback
- 💾 **Published cache** - reads hit one denormalized table instead of joining the normalized ones
- 🎨 **Nested structure** - Organize labels hierarchically
- 🔧 **Template variables** - Dynamic content with `{placeholder}` syntax
- 📝 **Draft & versioning** - Version control and audit logs

## Installation

```bash
pnpm spfn add @spfn/cms
```

Peer deps: `next` (`^16.3.3`), `react` (`^19.2.1`), `drizzle-orm` (`>=1.0.0-rc.4 <2`).

## Quick Start

### 1. Define Labels & Configuration

```typescript
// labels.ts
import { defineLabelConfig, defineLabels, createCmsClient } from '@spfn/cms';
import { getLocale } from '@spfn/cms/actions';

// Configure locales
export const labelConfig = defineLabelConfig({
    locales: ['en', 'ko'] as const,
    defaultLocale: 'ko',
    fallbackLocale: 'en'
});

// Define labels with nested structure
export const labelsDefinition = defineLabels({
    home: {
        hero: {
            title: { en: "Welcome", ko: "환영합니다" },
            subtitle: { en: "Start your journey", ko: "여정을 시작하세요" },
            greeting: { en: "Hello {name}!", ko: "{name}님 안녕하세요!" }
        },
        cta: { en: "Get Started", ko: "시작하기" }
    },
    about: {
        title: { en: "About Us", ko: "회사 소개" }
    }
});

// Create client with API, getLabel, getLabels, and format
export const { api, getLabel, getLabels, format } = createCmsClient(
    labelsDefinition,
    {
        defaultLocale: labelConfig.defaultLocale,
        fallbackLocale: labelConfig.fallbackLocale,
        getLocale: () => getLocale(labelConfig.defaultLocale),
    }
);
```

### 2. Enable Auto-Sync

```typescript
// server.config.ts
import { defineServerConfig } from '@spfn/core/server';
import { syncLabels } from '@spfn/cms/server';
import { labelsDefinition } from './labels';


// Option 1: Single definition
export default defineServerConfig()
    .lifecycle({
        afterInfrastructure: async () => {
            await syncLabels(labelsDefinition);
        }
    })
    .build();

// Option 2: Multiple definitions (organized in separate files)
import { homeLabels } from './labels/home';
import { aboutLabels } from './labels/about';

export default defineServerConfig()
    .lifecycle({
        afterInfrastructure: async () => {
            await syncLabels([homeLabels, aboutLabels]);
        }
    })
    .build();
```

### 3. Use in Your App

**Server Component (Single Section):**

```typescript
import { getLabel, format } from '@/labels';

export default async function HomePage() {
    // Single section - direct access without section name
    const label = await getLabel('home');

    return (
        <div>
            <h1>{label.hero.title}</h1>
            <p>{label.hero.subtitle}</p>
            <button>{label.cta}</button>

            {/* Template variables */}
            <p>{format(label.hero.greeting, { name: 'John' })}</p>
            {/* Output: "John님 안녕하세요!" */}
        </div>
    );
}
```

**Server Component (Multiple Sections):**

```typescript
import { getLabels } from '@/labels';

export default async function MultiSectionPage() {
    // Multiple sections - with section names as keys
    const labels = await getLabels(['home', 'about']);

    return (
        <div>
            <h1>{labels.home.hero.title}</h1>
            <p>{labels.about.title}</p>
        </div>
    );
}
```

**Locale Management:**

```typescript
'use client';
import { setLocale } from '@spfn/cms/actions';

export function LanguageSwitcher() {
    return (
        <div>
            <button onClick={() => setLocale('ko')}>한국어</button>
            <button onClick={() => setLocale('en')}>English</button>
        </div>
    );
}
```

## Key Features

### 🎯 Type Safety

**Section Name Validation:**

```typescript
// ✅ Valid section names are enforced at compile time
const label = await getLabel('home'); // OK
await getLabel('homee'); // ❌ Compile error: 'homee' is not a valid section

// ✅ getLabel returns direct access (no section wrapper)
const homeLabel = await getLabel('home');
homeLabel.hero.title; // OK - direct access
homeLabel.cta; // OK

// ✅ getLabels requires array and returns sections with names
const labels = await getLabels(['home', 'about']);
labels.home.hero.title; // OK
labels.about.title; // OK
labels.contact.email; // ❌ Compile error: 'contact' was not requested
```

**Property Access Validation:**

```typescript
// Single section - direct access
const label = await getLabel('signup');

// ✅ IDE autocomplete works perfectly
label.title; // OK - direct access
label.userName; // OK
label.email; // OK

// ❌ Typos are caught at compile time
label.titlee; // ❌ Compile error
label.userName; // ❌ Compile error (typo)

// Multiple sections - with section names
const labels = await getLabels(['home', 'about']);
labels.home.hero.title; // OK
labels.about.title; // OK
```

**API Distinction:**

```typescript
// getLabel: Single section, direct access
const signup = await getLabel('signup');
signup.title; // ✅ Direct access (cleaner!)

// getLabels: Multiple sections, section names as keys
const multi = await getLabels(['home', 'signup']);
multi.home.title; // ✅ With section name
multi.signup.userName; // ✅ With section name
```

### 🎨 Nested Structure

```typescript
defineLabels({
    features: {
        analytics: {
            title: { en: "Analytics", ko: "분석" },
            description: { en: "Track metrics", ko: "지표 추적" }
        },
        security: {
            title: { en: "Security", ko: "보안" }
        }
    }
});

// Single section - direct access with nesting
const label = await getLabel('features');
label.analytics.title; // "분석" (auto locale, direct access!)
label.analytics.description; // "지표 추적"
label.security.title; // "보안"
```

### 🔧 Template Variables

```typescript
defineLabels({
    home: {
        welcome: {
            en: "Welcome {name}, you have {count} messages",
            ko: "{name}님, {count}개의 메시지가 있습니다"
        }
    }
});

const label = await getLabel('home');
const text = label.welcome; // Direct access!

format(text, { name: "John", count: 5 });
// Output: "John님, 5개의 메시지가 있습니다"
```

### 🍪 Smart Locale Detection

Automatic locale detection with priority:
1. User's cookie (`cms-locale`)
2. Config's `defaultLocale`
3. Final fallback: `'en'`

```typescript
// User sets locale (saved to cookie)
await setLocale('ko');

// Automatically uses 'ko' locale
const label = await getLabel('home');
label.hero.title; // "환영합니다" (Korean)

// Switch to English
await setLocale('en');
const label2 = await getLabel('home');
label2.hero.title; // "Welcome" (English)
```

### 🔄 Auto-Sync

Labels synchronize automatically on server startup:
- ✅ Creates new labels
- ✅ Updates changed labels (deep equality check)
- ✅ Skips unchanged labels (performance)
- ✅ Rebuilds published cache
- ⚠️ Optionally removes orphaned labels

## API Reference

### createCmsClient()

Factory function to create CMS client with API, getLabel, getLabels, and format utilities.

```typescript
const { api, getLabel, getLabels, format } = createCmsClient(labelsDefinition, {
    defaultLocale: labelConfig.defaultLocale,
    fallbackLocale: labelConfig.fallbackLocale,
    getLocale: () => getLocale(labelConfig.defaultLocale),
});
```

**Returns:**
- `api` - API client for CMS routes
- `getLabel(section)` - Fetch a single section (direct access)
- `getLabels(sections)` - Fetch multiple sections (with section names)
- `format(template, vars)` - Template variable substitution

### getLabel()

Fetch a **single section** from published cache with direct access (no section name wrapper).

```typescript
// Single section - direct access
const label = await getLabel('home');
label.hero.title; // Direct access without 'home.' prefix
label.cta;
```

**Use when:**
- You need labels from only ONE section
- You want cleaner, direct access to properties
- Most common use case for individual pages

**Returns:** Labels directly without section name wrapper

**Features:**
- Auto locale detection (cookie → defaultLocale → 'en')
- Direct property access (no section name)
- Type-safe with IDE autocomplete
- Merges published cache with defaults

### getLabels()

Fetch **multiple sections** from published cache with section names as keys.

```typescript
// Multiple sections - with section names
const labels = await getLabels(['home', 'about']);
labels.home.hero.title; // Access via section name
labels.about.title;
```

**Use when:**
- You need labels from MULTIPLE sections
- You're building a page that uses multiple label groups

**Returns:** Object with section names as keys

**Features:**
- Auto locale detection (cookie → defaultLocale → 'en')
- Section filtering (only processes requested sections)
- Type-safe: only requested sections available
- Merges published cache with defaults

**Performance:**
- Only requested sections are processed (not entire labelsDefinition)
- 10x faster when requesting specific sections
- Reduces CPU and memory usage proportionally

### format()

Replace template variables in strings.

```typescript
format("Hello {name}!", { name: "John" }); // "Hello John!"
format("{count} items", { count: 5 }); // "5 items"
```

**Syntax:** `{variableName}` - Supports strings and numbers

### setLocale() / getLocale()

Server actions for locale management (cookie-based).

```typescript
// Set user's preferred locale
await setLocale('ko'); // Saves to 'cms-locale' cookie

// Get current locale
const locale = await getLocale(defaultLocale); // Returns: cookie → defaultLocale → 'en'
```

**Cookie settings:**
- Name: `cms-locale`
- Max age: 1 year
- HttpOnly, Secure (production), SameSite: lax

### syncLabels()

Synchronize labels to database (server-side only).

```typescript
await syncLabels(labelsDefinition, {
    removeOrphaned: false, // Delete labels not in code
    dryRun: false // Preview changes without applying
});
```

**Returns:** `{ added, updated, removed, unchanged }`

## Admin API

CMS 라벨을 관리하기 위한 Admin API를 제공합니다. 섹션별 테이블 뷰로 라벨을 조회/수정/발행할 수 있습니다.

### Admin Routes

`cmsAppRouter`에 포함된 Admin 라우트들:

| Route | Method | Description |
|-------|--------|-------------|
| `getSectionLabels` | GET | 섹션의 모든 라벨 조회 (Draft/Published 상태 포함) |
| `saveSectionDraft` | PUT | 섹션 라벨 일괄 Draft 저장 |
| `publishSection` | POST | 섹션 전체 발행 (Draft → Published) |
| `resetSectionDraft` | DELETE | 섹션 Draft 초기화 |

### Admin UI 구현 예제

**1. API Client 설정:**

```typescript
// labels.ts
import { createCmsClient } from '@spfn/cms';

export const { api: cmsApi } = createCmsClient(labelsDefinition, {
    defaultLocale: labelConfig.defaultLocale,
    fallbackLocale: labelConfig.fallbackLocale,
    getLocale: () => getLocale(labelConfig.defaultLocale),
});
```

**2. 섹션 라벨 조회:**

```typescript
// 섹션의 모든 라벨을 Draft/Published 상태와 함께 조회
const data = await cmsApi.getSectionLabels.call({
    params: { section: 'home' },
    query: { locales: 'en,ko' },  // 콤마로 구분
});

// 반환값
{
    section: 'home',
    locales: ['en', 'ko'],
    labels: [
        {
            id: 1,
            key: 'home.hero.title',
            defaultValue: { en: 'Welcome', ko: '환영합니다' },
            draft: { en: 'Welcome!', ko: '환영합니다!' } | null,
            published: { en: 'Welcome', ko: '환영합니다' } | null,
            hasDraft: true
        },
        // ...
    ]
}
```

**3. Draft 저장:**

```typescript
// 수정된 라벨들을 Draft로 저장
await cmsApi.saveSectionDraft.call({
    params: { section: 'home' },
    body: {
        labels: [
            { id: 1, values: { en: 'Welcome!', ko: '환영합니다!' } },
            { id: 2, values: { ko: '새로운 부제목' } },  // 특정 locale만 수정 가능
        ]
    },
});
```

**4. 섹션 발행:**

```typescript
// Draft가 있는 모든 라벨을 Published로 발행
const result = await cmsApi.publishSection.call({
    params: { section: 'home' },
    body: { locales: ['en', 'ko'] },
});

// 반환값
{
    published: 2,           // 발행된 라벨 수
    version: 3,             // 최대 버전 번호
    labels: ['home.hero.title', 'home.hero.subtitle']  // 발행된 라벨 키
}
```

**5. Draft 초기화:**

```typescript
// 섹션의 모든 Draft 삭제 (Published 값으로 복원)
await cmsApi.resetSectionDraft.call({
    params: { section: 'home' },
});
```

### Workflow

```
┌─────────────┐     saveSectionDraft     ┌─────────────┐
│  Default    │ ──────────────────────►  │    Draft    │
│  (코드 정의)  │                          │ (version:null)│
└─────────────┘                          └──────┬──────┘
                                                │
                    publishSection              │
                ◄───────────────────────────────┘
                                                │
                                                ▼
                                         ┌─────────────┐
                                         │  Published  │
                                         │ (version:N) │
                                         └─────────────┘
```

**상태 우선순위:** Draft > Published > Default

### 상태 표시

| 상태 | 의미 | UI 표시 예 |
|------|------|-----------|
| Default | 코드에 정의된 기본값만 존재 | 회색 |
| Draft | 저장되었으나 미발행 | 노란색 |
| Published | 발행되어 실제 서비스에 반영 | 초록색 |
| Edited | UI에서 수정 중 (미저장) | 파란색 |

## Architecture

### Database Schema

```
cms_labels (metadata)
  ├─ id, key, section, type, defaultValue
  └─ publishedVersion

cms_label_values (actual content)
  ├─ labelId, version, locale, breakpoint
  └─ value (JSONB)

cms_published_cache (performance)
  ├─ section, locale, content (JSONB)
  └─ version (for cache invalidation)
```

### Query Flow

1. **getLabels()** → published_cache (a single query, no joins)
2. **Fallback** → bindLocale(defaults)
3. **Merge** → cache overrides defaults
4. **Return** → type-safe nested object

## Performance

- **Published cache:** one denormalized read replaces the join across the normalized
  tables.
- **N+1 prevention:** Bulk section queries with `inArray()`
- **Section filtering:** only the requested sections are processed, so asking for one
  section does not pay for the whole catalog.
- **Unchanged labels:** Skipped during sync (deep equality check)
- **Client caching:** Version-based invalidation

### Example: Large Scale

```typescript
// 10 sections with 100 labels each = 1,000 total labels
const labelsDefinition = {
    home: { /* 100 labels */ },
    about: { /* 100 labels */ },
    products: { /* 100 labels */ },
    // ... 7 more sections
};

// Only request 'home' - direct access
const label = await getLabel('home');

// ✅ Performance: Processes only 100 labels (10% of total)
// ❌ Without filtering: Would process all 1,000 labels
```

**Benefits:**
- CPU usage: 10x reduction (100 vs 1,000 labels)
- Memory usage: 10x reduction
- Response time: Proportionally faster

## Development Status

This package is currently in alpha. APIs may change.

## License

MIT
