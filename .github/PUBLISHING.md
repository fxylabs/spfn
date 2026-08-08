# Publishing Packages

> **이 프로젝트는 레지스트리 두 곳에 배포한다** (2026-07-22 이후).
> 둘 다 버전 범프 커밋이 `main` 에 닿으면 자동으로 나간다 (2026-08-05 이후):
> 비공개 Gitea 레지스트리는 Woodpecker(`.woodpecker.yml` →
> `scripts/publish-changed.mjs`)가, 공개 npmjs 는 GitHub 미러의 패키지별
> Actions 워크플로우가 맡는다. 레지스트리에 이미 있는 버전은 양쪽 다 건너뛴다.
> 아래 로컬 수동 절차는 파이프라인이 못 돌 때의 fallback 이다.

## 어디로 — Gitea 비공개 레지스트리

`https://git.superfunction.xyz/api/packages/superfunction/npm/`

- 인증은 `~/.npmrc`의 해당 레지스트리 토큰을 쓴다. 공개 npm(`npm login`) 불필요.
- `@spfn/*` scoped 패키지는 `~/.npmrc`의 `@spfn:registry` 스코프 덕에 자동으로 이 레지스트리로 간다.
- unscoped `spfn` CLI는 자기 `publishConfig.registry`로 같은 레지스트리에 고정돼 있다.

## 어떻게 — 패키지별 named script

```bash
# 1) 버전 올리기 (동일 버전 재배포 불가)
#    packages/<pkg>/package.json 의 "version"

# 2) 빌드 (auth 는 의존 패키지 먼저)
pnpm --filter @spfn/core --filter @spfn/notification --filter @spfn/auth build
pnpm --filter spfn build

# 3) 패키지 디렉터리에서 named script 로 publish
cd packages/auth && npm run publish:beta
cd packages/cli  && npm run publish:beta

# 4) 버전 범프 커밋을 main 에 push (origin = Gitea)
#    → GitHub 미러가 받아 공개 npmjs 워크플로우가 같은 버전을 배포한다
```

각 패키지에 `publish:alpha` / `publish:beta` / `publish:latest` 스크립트가 있다.
셋 다 `scripts/publish-package.mjs <channel>` 을 돌리는데, 이건
`npm publish --access public --tag <channel>` 을 실행한 뒤 **`latest` dist-tag 를 방금
올린 버전으로 옮긴다**. 안정 릴리스가 없는 레지스트리에서 `latest` 가 옛 버전에
얼어붙어 맨 `npm install` 이 낡은 빌드를 주는 걸 막기 위한 것이다.

## ⚠️ bare publish 금지

`publishConfig.tag` 는 이 환경의 npm·pnpm 둘 다 **무시**한다. 그래서 그냥
`pnpm publish` / `npm publish` 를 돌리면 버전이 beta 라도 **`latest` dist-tag**로
잘못 붙는다. 반드시 `--tag` 를 박은 named script(`npm run publish:beta`)를 쓴다.

## npm tag 규칙

| 버전 형식 | 써야 할 스크립트 | dist-tag |
|-----------|----------------|----------|
| `x.x.x-alpha.x` | `npm run publish:alpha` | `alpha` |
| `x.x.x-beta.x` | `npm run publish:beta` | `beta` |
| `x.x.x` (stable) | `npm run publish:latest` | `latest` |

## 검증

```bash
# scoped 은 스코프가 Gitea 로 해석됨
npm view @spfn/auth@<version> version

# unscoped spfn 은 레지스트리를 명시해야 Gitea 를 본다 (아니면 공개 npm 조회)
npm view spfn@<version> version --registry https://git.superfunction.xyz/api/packages/superfunction/npm/

# 공개 npmjs 쪽은 직접 질의한다 — scoped 패키지는 `--registry` 로 못 바꾼다
curl -s https://registry.npmjs.org/@spfn%2Fauth
```

`~/.npmrc` 의 `@spfn:registry` 스코프 설정이 `--registry` 플래그를 이긴다. 그래서
`npm view @spfn/...` 이 알려주는 버전·dist-tag 는 언제나 Gitea 쪽 이야기다.

---

## 공개 npmjs — 패키지별 GitHub Actions 워크플로우

`.github/workflows/publish-<pkg>.yml` 이 **공개 npm(npmjs.org)** 배포를 맡는다.

- 트리거: `packages/<pkg>/package.json` 변경이 GitHub 의 `main` 에 push 될 때.
  origin 은 Gitea 이고 GitHub 은 미러라, Gitea 에 push 하면 미러를 타고 돌아간다.
- **파일이 바뀌었다고 배포하지는 않는다.** 워크플로우는 push 이전 커밋의
  `version` 과 지금의 `version` 을 비교해서, 값이 실제로 움직였을 때만 배포한다.
  peer 선언을 걷어내거나 script 를 고치느라 같은 파일을 건드려도 릴리스가 나가지
  않는다 — `0.3.0-beta.1` 이 그렇게 나갔고, 그때는 이 비교가 없었다.
  `npm view` 가드는 뒤에 그대로 남아 있어 재배포를 막는다.
  workflow_dispatch 는 이 비교를 건너뛴다. 이미 커밋된 버전을 백필하는 경로이기 때문이다.
- dist-tag 는 버전 문자열에서 뽑는다 — `-alpha` → `alpha`, `-beta` → `beta`,
  그 외 → `latest`.
- publish 후 `latest` dist-tag 를 그 버전으로 동기화한다. workflow_dispatch 로
  다시 돌리면 이미 배포된 버전에 대해서도 `latest` 만 다시 맞춘다 (백필용).
- GitHub Release 는 자동으로 만들지 않는다. 원할 때 workflow_dispatch 의
  `create_release` 를 켜서 돌리면 그 버전 태그로 Release 를 만든다 — 노트는
  자동 생성이고, alpha/beta 는 prerelease 로 표시된다.
- unscoped `spfn` CLI 워크플로우는 publish 직전에 `publishConfig.registry` 를 지운다.
  그래야 npmjs 로 나가고, 배포된 아티팩트에 내부 레지스트리 주소가 박히지 않는다.

`.github/workflows/publish.yml` (`v*` 태그로 전 패키지 일괄 배포) 은 옛 경로다.
모든 패키지를 `alpha` 태그로 밀어버리므로 쓰지 않는다 — 패키지별 워크플로우가 대체했다.
`RELEASE.md` 본문의 태그 기반 릴리스 절차도 같은 구 방식이라 더 이상 유효하지 않다.
