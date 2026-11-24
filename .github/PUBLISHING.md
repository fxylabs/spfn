# Publishing Packages

> **이 프로젝트는 레지스트리 두 곳에 배포하지만, 빌드는 한 번이다** (#463, 2026-11-23 이후).
> 버전 범프 커밋이 `main` 에 닿으면 Gitea Actions(`.gitea/workflows/release.yml` →
> `scripts/publish-changed.mjs`)가 전체 체크 뒤에 빌드해서 비공개 Gitea 레지스트리에 올린다.
> 공개 npmjs 는 GitHub 미러의 패키지별 워크플로우가 맡는데, **다시 빌드하지 않는다** —
> Gitea 레지스트리에 그 버전이 올라올 때까지 기다렸다가 그 tarball 을 받아
> `dist.integrity` 를 검증하고 같은 바이트를 그대로 npmjs 에 올린다. 그래서 한 버전의
> 체크섬은 어느 레지스트리에서 받아도 같다. 아래 로컬 수동 절차는 파이프라인이 못 돌 때의
> fallback 이다 (Gitea 쪽만 대신한다).

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
#    → GitHub 미러가 받아, 공개 npmjs 워크플로우가 3) 에서 Gitea 에 올린 바로 그
#      tarball 을 npmjs 에 올린다 (CI 의 release.yml 은 이미 있는 버전이라 건너뛴다)
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

## 공개 npmjs — Gitea 의 tarball 을 그대로 올린다

`.github/workflows/publish-<pkg>.yml` 열네 개가 **공개 npm(npmjs.org)** 배포의 입구다.
내용은 전부 재사용 워크플로우 `publish-from-gitea.yml` 하나를 부르는 것과 패키지별 `concurrency`
그룹뿐이고, 일은 `scripts/republish-from-gitea.mjs`(`scripts/lib/republish.mjs`) 가 한다.

- 트리거: `packages/<pkg>/package.json` 변경이 GitHub 의 `main` 에 push 될 때.
  origin 은 Gitea 이고 GitHub 은 미러라, Gitea 에 push 하면 미러를 타고 돌아간다.
- **파일이 바뀌었다고 배포하지는 않는다.** push 이전 커밋의 `version` 과 지금의
  `version` 을 비교해서, 값이 실제로 움직였을 때만 진행한다. push 이전 커밋을 clone 에서
  읽을 수 없으면(예: force push) 짐작하지 않고 그 이유로 실패한다.
  workflow_dispatch 는 이 비교를 건너뛴다. 이미 커밋된 버전을 백필하는 경로이기 때문이다.
- **빌드하지 않는다.** 미러 push 는 Gitea 의 release 실행(전체 체크 약 25분, 그 뒤 publish)
  보다 훨씬 먼저 도착하므로, 스크립트는 Gitea 레지스트리에 그 버전이 생길 때까지 30초
  간격으로 묻는다. 상한은 **90분** — 측정한 release 실행 22.7–26.7분, 앞 실행 뒤에 줄을 선
  경우 push 부터 publish 까지 47.7분에 여유를 둔 값이다. 넘으면 "Gitea release 가 이 버전을
  올리지 않았다" 는 메시지로 실패한다. 기다리는 건 "아직 없음"(404) 뿐이다 — 401·403·5xx 는
  즉시 실패다.
- tarball 은 Gitea 메타데이터가 가리키는 URL 에서 받는다. 그 URL 이 Gitea 레지스트리와
  다른 origin 이면 토큰을 보내지 않고 거부한다. 받은 바이트는 Gitea 의 `dist.integrity`
  (sha512) 와 맞아야 하고, 다르면 아무것도 올리지 않는다.
- npmjs 에 그 버전이 이미 있으면 integrity 를 비교한다. 같으면 아래 dist-tag 규칙만 다시
  적용하고 초록, **다르면 빨강** — 한 버전이 두 tarball 로 갈라진 상태이고, 어느 레지스트리에서도
  버전을 바꿔 올릴 수 없으므로 그 버전은 고칠 수 없다. 다음 버전부터 하나로 맞는다.
- 없으면 `npm publish <파일> --access public --tag publishing --registry https://registry.npmjs.org/ --provenance`
  로 올린다. **채널 tag 로 올리지 않는다**: `npm publish` 의 `--tag` 는 npmjs 가 처리를 마칠 때 —
  몇 분 뒤, 아래 규칙 밖에서 — 붙이므로, 채널 tag 로 올리면 더 새 버전이 먼저 처리를 마친 경우 그
  tag 가 뒤로 간다. npm 은 tag 없이 올릴 수 없으니(`--tag` 를 빼면 `latest`) 규칙이 다루지 않는
  **패키지마다 하나뿐인 고정** 임시 tag `publishing`(`PUBLISH_TAG`)으로 올리고, 채널 tag 와 `latest` 는
  npmjs 가 버전을 내준 뒤 스크립트가 규칙대로 옮긴다. `publishing` 은 **아무도 지우지 않는다** —
  npmjs 는 배포 토큰의 dist-tag 삭제를 거절하고(아래 "0.4.0-beta.6"), 다음 publish 가 어차피
  옮긴다. npm 이 tag 이름으로 거절하는 것은 SemVer range 로 읽히는 이름과 `encodeURIComponent` 가
  바꾸는 글자가 든 이름이다(npm 12.2.3 `publish`·`dist-tag add`·npm-package-arg) — `publishing` 은
  어느 쪽도 아니다.
- **`publishing` 이 어느 버전을 가리키든 설치는 달라지지 않는다.** 채널 tag 가 아니고, 규칙은 이
  tag 를 읽지도 옮기지도 않으며(`tagsToMove` 는 채널 tag 와 `latest` 만 본다), 워크플로우·스크립트
  어디서도 읽지 않는다. 맨 `npm install` 은 `latest` 만 쓰고, `<pkg>@publishing` 을 일부러 적지 않는 한
  아무 설치도 이 tag 를 거치지 않는다. 한 패키지의 실행은 겹치지 않지만(아래 `concurrency`), 두 버전이
  동시에 처리 중일 수는 있다: v9 의 실행이 15분 안에 내주지 않아 `not-served` 로 끝나고, 대기열의
  다음 실행이 v10 을 publish 하는데 v9 가 아직 처리 중인 경우다. 그러면 npmjs 가 처리를 마칠 때마다
  `publishing` 을 옮기므로 두 번 옮기고, 그 순서는 우리가 정하지 않는다 — v9 가 나중에 끝나면
  `publishing` 은 v9 에 남는다. 그래도 v10 의 실행은 v10 을 내준 뒤 채널 tag 와 `latest` 를 규칙대로
  v10 에 두고, v9 의 처리 끝은 `publishing` 만 건드린다. 나중에 v9 를 재실행하면 이미 있는 버전 경로로
  가서 v10 에 있는 tag 를 뒤로 옮기지 않고("left npmjs's … dist-tag on 1.0.0-beta.10") 초록으로
  끝난다. (v9 처리 중이라 npmjs 가 v10 의 publish 를 E409 로 거절하면 — 알려져 있으나 측정하지
  않았다 — v10 의 실행은 기다리다 `not-served` 로 끝나고, 재실행이 publish 한다.)
- **npmjs 는 publish 를 받은 뒤 처리하고 나서야 그 버전을 내준다.** `npm publish` 는 버전·tarball·
  `--tag` 를 PUT 한 번에 보내고 레지스트리가 받았다고(2xx) 답하면 끝난다 — 로그의 "Your package is
  being processed and may take a few minutes to become available." 는 그 응답의 `npm-notice`
  헤더다. npm 은 publish 마다 악성코드 검사를 하고, 그동안 버전 문서는 404 `version not found`,
  dist-tag 도 그대로다 (`--tag` 로 준 tag 는 처리가 끝날 때 버전과 함께 붙는다). npm 이 밝힌 지연은
  "typically around five minutes … up to 15 minutes or more", 보장값이 아니고 수동 검토로 붙들릴
  수도 있다 ([GitHub changelog, 2026-07-28](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/)).
  그래서 스크립트는 publish 뒤 버전 문서(`/<name>/<version>`)를 30초 간격으로 묻는다. 기다리는
  시간은 **15분** — npm 이 밝힌 보통의 위쪽 값("up to 15 minutes or more", "aren't a service
  guarantee")이지 상한이 아니다. 기다리는 건 404 뿐이고 다른 답은 즉시 실패다. npmjs 가 내주면
  `dist.integrity` 를 Gitea 와 비교하고(다르면 실패), **그 다음에야** dist-tag 를 읽어 아래 규칙대로
  옮긴다. 처리 중인 버전에도 `npm dist-tag add` 는 통하지만(npm 문서), 내주지도 않는 — 막힐 수도
  있는 — 버전에 `latest` 를 붙이지 않으려고 기다린 뒤에 옮긴다. 버전 문서의 404 는 캐시되지
  않아(2026-11-23 측정) 묻는 족족 지금 상태다.
- **15분 안에 내주지 않으면** 실패하고(`outcome=not-served`, 요약의 npmjs 칸이 그렇게 말한다),
  dist-tag 는 하나도 옮기지 않는다. 스크립트가 아는 것은 **npmjs 가 그 버전을 아직 내주지 않았다**
  는 것뿐이다. 그럴 만한 이유: 아직 처리 중, 수동 검토로 붙들림, 차단됨, 또는 (publish 가 거절된
  경우) npmjs 가 그 버전을 받은 적이 없음 — 같은 패키지의 다른 버전이 처리 중일 때도 E409 가
  온다고 알려져 있고(**측정하지 않았다**), 그러면 재실행이 publish 한다 — 이거나 npmjs 가 다시 받지
  않는 버전 번호 — 한 번 올렸다 지운 버전 번호는 다시 쓸 수 없고, 그러면 새 버전으로 릴리스해야
  한다. 어느 쪽인지는 npmjs 의 패키지 페이지
  (`https://www.npmjs.com/package/<name>/v/<version>`)에서 본다. **재실행은 다시 기다리고, npmjs 가
  그 버전을 내줄 때에만 마무리된다**(비교하고 tag 를 옮긴다) — 내주지 않는 한 몇 번을 돌려도
  같은 실패다.
- **이미 쓰인 버전 번호라는 거절**(E409, 또는 "cannot publish over the previously published
  versions") 을 받으면 스크립트는 그 거절로 실패하지 않고 위와 똑같이 기다린다. 결과는 내주면
  `already-published`. 처리 중에 재실행한 경우가 이것이다: 버전 문서가 아직 404 라 다시 publish
  하고 거절된다. 다만 처리 중인 버전에 npmjs 가 정확히 어떤 거절을 주는지는 **측정하지 않았다**
  (publish 해야 잴 수 있다). 같은 거절이 이미 내주는 버전, 올렸다 지운 버전에도 오고, E409 는 같은 패키지의 다른 버전이 처리
  중일 때도 온다고 알려져 있다(측정하지 않았다 — 이때 이 버전은 올라간 적이 없다). 거절만으로는
  어느 쪽인지 알 수 없다. 지운 버전은 packument 의 `time` 에 남고 `versions` 에서 빠지지만,
  처리 중인 버전이 `time` 에 없다고 밝힌 npm 자료가 없다 — 0.4.0-beta.5 의 `time` 값(12:29:20Z)이
  publish 수락(12:27:11Z)보다 처리 끝(12:29:31Z)에 가깝다는 관측 하나뿐이고, 그 값은 항목이 언제
  생겼는지는 말하지 않는다. 그래서 `time` 으로 "다시는 안 받는 번호" 를 가려 즉시 실패시키지
  않고, 기다린 뒤 위의 메시지로 끝낸다.
- Gitea 레지스트리는 이런 처리 단계가 없다: publish 요청 안에서 버전을 저장하고 답한다. 그래서
  `publish-package.mjs` 가 publish 직후 `latest` 를 옮기고, `publish-changed.mjs` 가 E409 직후 다시
  물어 "이미 있음" 을 확인하는 것이 그대로 맞다.
- `create_tag` 인 실행은 publish 전에 npmjs 에 그 버전이 있는지 **버전 문서**로 묻는다(404 만 "없음").
  `npm view` 는 packument 를 읽는데 npmjs CDN 이 300초 캐시해서(측정: `cache-control: public,
  max-age=300`, `cf-cache-status: HIT`), npmjs 가 버전을 내주기 시작한 뒤에도 몇 분 동안 "없다" 고
  답할 수 있다 — 그러면 그 실행이 만든 git tag 를 보고 "Tag … already exists" 로 멈춘다. 처리 중인
  버전도 여기서는 "없음" 이지만, git tag 는 npmjs 가 버전을 내준 걸 본 실행만 만들므로 그 버전의
  tag 는 아직 있을 수 없다.
- **dist-tag 규칙.** 어느 tag 를 노리는지는 `main` 의 채널 규칙 그대로다 — 버전 문자열의
  채널(`-alpha` → `alpha`, `-beta` → `beta`, 그 외 → `latest`)과, alpha·beta 도 포함해 언제나
  `latest`. 바뀐 건 하나: **tag 는 지금 가리키는 버전보다 새 버전으로만 옮긴다** (Semantic
  Versioning 우선순위, pre-release 식별자 포함 — `1.0.0-alpha.9 < 1.0.0-beta.1 < 1.0.0-beta.10
  < 1.0.0 < 1.1.0-alpha.1`). 같은 패키지의 두 릴리스가 순서가 뒤바뀌어 끝나도 tag 는 새 쪽에
  남고, 실행 로그가 "left npmjs's latest dist-tag on …" 으로 옮기지 않았다고 말한다. tag 는
  npmjs 의 `/-/package/<name>/dist-tags` 에서 읽는다 — 캐시 헤더가 없고 거듭 물어도 Cloudflare
  가 `DYNAMIC` 으로 답했다(측정). 패키지 문서(packument)는 300초 캐시라 쓰지 않는다. 노리는 tag 가 모두 더 새
  버전을 가리키는 버전은 어느 tag 도 받지 않는다(예전의 `superseded` tag 는 이제 붙지 않고, 이미
  붙은 것은 그대로 남는다).
- **한 패키지의 실행은 한 번에 하나다.** 규칙은 dist-tag 를 읽은 뒤 쓰는데 npm dist-tag 에는
  compare-and-swap 이 없어서, 두 실행이 겹치면 A 가 읽고 → B 가 v10 으로 옮기고 → A 가 v9 를 쓰는
  순서로 tag 가 옛 버전에 남을 수 있다. 그래서 열네 caller 가 각자 `concurrency: { group:
  publish-npmjs-packages/<pkg>, queue: max }` 를 둔다. GitHub 문서
  ([Control the concurrency of workflows and jobs](https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/control-the-concurrency-of-workflows-and-jobs)):
  기본값 `single` 은 "When a new job or workflow run is queued, any existing `pending` job or workflow
  run in the same group is canceled and replaced" — 취소된 실행은 npmjs 에 끝내 안 올라가는 버전이라
  쓰지 않는다. `max` 는 "Up to 100 jobs or workflow runs can be `pending` in the concurrency group",
  대기 순서는 "processed in first-in-first-out (FIFO) order according to the time each one started
  waiting on the concurrency group … Since the actual start time of a job or run may vary, ordering is
  not guaranteed"([workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax))
  — 순서가 바뀌어도 규칙이 tag 를 새 쪽에 둔다. 100개가 넘게 쌓이면 GitHub 이 그 뒤를 취소한다(그럴 일은 없지만
  그 경우 그 버전은 workflow_dispatch 로 백필한다). 그룹 이름은 저장소 안에서만 유효하다("in the
  repository"). 같은 버전의 push 실행과 dispatch 도 같은 그룹이라 겹치지 않는다.
- 이미 있는 버전에도 규칙을 다시 적용하므로, publish 는 됐는데 `dist-tag` 에서 실패한 실행은
  어떤 재실행(push 의 "Re-run", workflow_dispatch)으로도 마무리된다. workflow_dispatch 는
  버전 비교를 건너뛰는 백필 경로다. `dry_run` 은 `npm publish --dry-run` 까지만 하고
  dist-tag 는 건드리지 않는다. 로컬에서도 같은 dry run 을 돌릴 수 있다:
  `GITEA_PACKAGES_READ_TOKEN=… node scripts/republish-from-gitea.mjs packages/core --dry-run`.
- **git tag `<name>@<version>` 은 그 버전을 정한 커밋에 붙는다** — 실행이 도는 커밋이 아니다.
  `scripts/version-commit.mjs` 가 `package.json` 의 first-parent 이력을 거슬러 `version` 이
  지금 값으로 마지막으로 바뀐 커밋을 찾는다. **tag 는 그걸 요청한 workflow_dispatch 만 만든다**:
  그 커밋에서 시작해 `create_tag` 를 켠 실행(과 그 재실행), 또는 `create_release` 를 켠 실행(아래
  Release 단계가 tag 가 없으면 그 커밋에 만든다). 뒤의 `main` head 에서 돌린 workflow_dispatch 는
  `create_tag` 를 켜도 tag 를 만들지 않고, 로그와 요약에 "Not tagging …: the version was set in
  <커밋> and this run is at <커밋>" 이라고 남긴다. **push 실행은 tag 를 만든 적이 없다**:
  `create_tag` 는 workflow_dispatch 의 입력이고 열네 caller 는 push 에 `inputs.create_tag || false`,
  곧 `false` 를 넘긴다(#463 이전부터 그랬다). 지금까지 어느 버전도 git tag 가 없는 이유다.
- GitHub Release 는 자동으로 만들지 않는다. workflow_dispatch 의 `create_release` 를 켜면
  그 버전 태그로 Release 를 만든다 — 노트는 자동 생성이고, alpha/beta 는 prerelease 다. tag 가
  아직 없으면 gh 가 그 버전을 정한 커밋에 만든다. tag 가 다른 커밋에 있으면 실패한다(GitHub 은
  이미 있는 tag 에는 `--target` 을 쓰지 않는다). 그 커밋의 tag 에 이미 게시된 Release 가 있으면
  앞 실행이 끝낸 것으로 보고 넘어가고 — 만들기 전에 `gh release view` 와 `git ls-remote` 로
  확인한다 — 그 밖의 실패는 모두 단계를 실패시킨다. 이 수정(#487) 전에는 `gh release create … || echo
  "::warning::…"` 라서, Release 도 tag 도 못 만든 실행이 초록으로 끝났다.
- unscoped `spfn` CLI 의 tarball 에는 `publishConfig.registry`(Gitea) 가 들어 있다 — 로컬
  `npm run publish:*` 가 npmjs 로 새지 않게 하는 핀이다. 예전 워크플로우는 publish 전에 이
  키를 지웠고, 그래서 `spfn` 의 npmjs tarball 은 Gitea 것과 항상 달랐다. 이제 tarball 을 건드리지
  않고 명령줄의 `--registry` 로 npmjs 를 가리킨다 (npm 은 명령줄 플래그를 `publishConfig` 보다
  우선한다). 핀은 두 레지스트리에 똑같이 실린다. 설치하는 쪽에는 아무 효과가 없다.

### 인증 — `NPM_TOKEN`

- npmjs 인증은 #463 이전과 같다: GitHub 시크릿 **`NPM_TOKEN`**(`superfunction` 사용자의 npm
  토큰). `actions/setup-node` 의 `registry-url` 이 쓰는 `.npmrc` 가 `NODE_AUTH_TOKEN` 을 읽고,
  스크립트는 그 변수를 `npm publish`·`npm dist-tag` 프로세스에만 넘긴다. 비어 있으면 dry run 이
  아닌 실행은 republish 단계가 `NPM_TOKEN is not set` 으로 바로 실패한다.
- `--provenance` 도 그대로다. npm 은 tarball 의 sha512 위에 "이 워크플로우 실행·이 커밋" 을
  적은 statement 에 서명한다. 바이트는 같은 push 에서 Gitea release 가 빌드한 것이라, statement
  의 소스(저장소·커밋)는 맞지만 거기 적힌 빌드는 다시 올리기만 한 이 job 이다.
- **OIDC trusted publishing 으로 옮기는 건 #466** 이다 (npmjs 에서 열네 패키지의 trusted
  publisher 를 설정한 뒤). 그때 바뀌는 파일은 열다섯 개다. 스크립트는 그대로다.
  - `publish-from-gitea.yml`: `on.workflow_call.secrets` 의 `NPM_TOKEN` 선언, republish 단계의
    `NPM_TOKEN` 환경변수와 비었으면 실패하는 부분을 지우고, npm 을 `^11.21.0`(trusted
    publishing 의 `dist-tag` 에 필요한 버전)으로 고정한다.
  - 열네 개의 `publish-<pkg>.yml` — `publish-auth.yml`, `publish-cli.yml`, `publish-cms.yml`,
    `publish-core.yml`, `publish-i18n.yml`, `publish-mcp.yml`, `publish-migrate.yml`,
    `publish-monitor.yml`, `publish-notification.yml`, `publish-pages-next.yml`, `publish-pages.yml`,
    `publish-signing.yml`, `publish-storage.yml`, `publish-workflow.yml`: 각자의 `secrets:` 에서
    `NPM_TOKEN: ${{ secrets.NPM_TOKEN }}` 줄을 지운다. 같은 변경에서 지워야 한다 — GitHub 문서
    ([`on.workflow_call.secrets`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onworkflow_callsecrets)):
    "If a caller workflow passes a secret that is not specified in the called workflow, this
    results in an error." 선언만 지우면 열네 워크플로우가 모두 오류로 멈춘다. 반대로 선언을
    남겨 두면 쓰이지 않는 `NPM_TOKEN` 이 계속 열네 파일을 거쳐 넘어간다.
  - npm 은 trusted publisher 를 호출하는 쪽 파일 이름(`publish-<pkg>.yml`)과 맞추므로 열네 파일은
    그대로 입구로 남는다.
- 시크릿은 하나 더 있다: **`GITEA_PACKAGES_READ_TOKEN`** — `superfunction` 조직의 패키지를
  **읽기만** 할 수 있는 Gitea 토큰(scope `read:package`). 두 시크릿 모두 republish 단계의
  환경변수로만 넘어가고, 그 안에서도 각자 필요한 곳에만 간다 — Gitea 토큰은 Gitea 레지스트리
  요청의 헤더에만, npm 토큰은 `npm` 자식 프로세스에만 (`npm` 은 Gitea 토큰을 상속받지 않는다).

### 로컬 fallback 과 tarball 하나

`publish-package.mjs` 는 따로 `pack` 하지 않고 `npm publish` 가 패키지 디렉터리를 직접 묶는다 —
한 번 publish 에 tarball 하나다. Gitea 레지스트리는 버전을 덮어쓰지 않으므로, 사람이 로컬에서
`npm run publish:beta` 를 하고 CI(release.yml 이나 아직 도는 Woodpecker)도 같은 버전을 올리면
**먼저 Gitea 에 닿은 쪽이 이기고** 나머지는 E409 를 받는다 (CI 는 다시 물어 "이미 있음" 으로
끝난다). npmjs 는 어느 쪽이 이겼든 Gitea 에 있는 그 tarball 을 받으므로 두 번째 tarball 이 생기지
않는다. 남은 구멍은 하나 — 로컬 publish 가 Gitea 가 아니라 npmjs 로 나가는 경우(`~/.npmrc` 에
`@spfn:registry` 가 없을 때) 다. 그러면 npmjs 워크플로우가 integrity 불일치로 빨갛게 끝나서
드러나지만, 그 버전은 갈라진 채로 남는다.

### 0.4.0-beta.6 — npmjs 가 임시 tag 삭제를 거절했다 (#487)

#474 는 버전마다 다른 임시 tag `publishing-<version>` 으로 올리고, 채널 tag 와 `latest` 를 옮긴 뒤
그 tag 를 `npm dist-tag rm` 으로 지웠다. 그 흐름을 처음 탄 0.4.0-beta.6 (여덟 패키지, push
2026-11-24 04:48Z) 에서 여덟 실행 모두 publish·대기·integrity 비교(Gitea 와 같음)·채널 tag 와
`latest` 이동까지 마친 뒤 마지막 삭제에서 실패했다:

```
npm error code E403
npm error 403 403 Forbidden - DELETE https://registry.npmjs.org/-/package/@spfn%2fcore/dist-tags/publishing-0.4.0-beta.6
```

같은 토큰이 같은 실행에서 dist-tag 를 붙이고 옮겼는데 삭제만 거절됐다 — 배포 토큰에 dist-tag 삭제
권한이 없다. review 는 publish 할 수 없어서 첫 릴리스 전에는 아무것도 이 경로를 타지 않았다. 그래서
임시 tag 는 이제 패키지마다 하나, `publishing` 이고 아무도 지우지 않는다(위). `publishTagOf` 는
없어졌다(`PUBLISH_TAG` 가 대신한다).

- **남은 `publishing-<version>` tag 여덟 개** — `@spfn/auth`·`spfn`·`@spfn/cms`·`@spfn/core`·`@spfn/mcp`
  의 `publishing-0.4.0-beta.6`, `@spfn/monitor`·`@spfn/notification` 의 `publishing-0.3.0-beta.6`,
  `@spfn/workflow` 의 `publishing-0.3.0-alpha.6` — 는 무해하다. 각각 자기 버전을 가리키고, 채널 tag 가
  아니며, 아무것도 읽지 않는다. 지울 수 있는 건 dist-tag 삭제가 허락된 로그인뿐이다
  (`npm dist-tag rm <name> publishing-<version>`); 워크플로우는 지우지 않는다.
- **beta.6 의 git tag 백필 — 하지 않아도 된다. 할지는 owner 가 정한다.** 지금까지 어느 버전에도 git
  tag 가 있었던 적이 없고, 백필은 tag 여덟 개와 함께 GitHub prerelease 여덟 개도 게시한다. 하기로
  하면 이렇게 한다. npmjs 에 이미 있는 버전의 workflow_dispatch 는 이미 있는 버전 경로로 간다:
  아무것도 뒤로 옮기지 않고 초록으로 끝난다. 이 수정이 `main` 에 들어간 뒤 `main` 에서 돌리므로
  실행 커밋은 그 버전을 정한 커밋(`b26a1b34`, #485)이 아니고, `Create git tag` 는 `create_tag` 를 켜도
  "Not tagging …" 으로 넘어간다. 그 커밋의 실행으로 돌리면 #474 의 코드가 돌아 다시 403 이다. tag 를
  만드는 건 `create_release=true` 다: `Create GitHub release` 가 `gh release create <name>@<version>
  --target <그 버전을 정한 커밋>` 으로 tag 와 prerelease 를 함께 만든다. 패키지마다 한 번:

  ```bash
  for pkg in auth cli cms core mcp monitor notification workflow; do
      gh workflow run "publish-$pkg.yml" --repo fxylabs/spfn --ref main -f create_release=true
  done
  ```

  만들어지는 tag: `@spfn/auth@0.4.0-beta.6`, `spfn@0.4.0-beta.6`, `@spfn/cms@0.4.0-beta.6`,
  `@spfn/core@0.4.0-beta.6`, `@spfn/mcp@0.4.0-beta.6`, `@spfn/monitor@0.3.0-beta.6`,
  `@spfn/notification@0.3.0-beta.6`, `@spfn/workflow@0.3.0-alpha.6`. 주의할 점:
  - **여덟 패키지 중 어느 것이든 버전이 다시 움직이기 전에** 돌린다. 실행은 `main` head 의
    `package.json` 버전을 읽고 `scripts/version-commit.mjs` 가 그 버전을 정한 커밋을 실행 때 찾으므로,
    버전이 움직인 패키지는 beta.6 이 아니라 새 버전의 tag 와 Release 를 만든다.
  - 끝난 뒤 tag 가 있는지 확인한다 — 여덟 줄이어야 한다:
    `git ls-remote --tags https://github.com/fxylabs/spfn | grep -E '@0\.(4\.0-beta|3\.0-beta|3\.0-alpha)\.6$'`.
  - 이 tag 는 GitHub 에만 생긴다. GitHub 은 Gitea 의 미러라, 다음 미러 동기화가 Gitea 에 없는 tag 를
    지울 수 있다(**확인하지 않았다**).

### 이미 갈라진 버전

#463 이전에 두 번 빌드된 버전은 그대로 남는다 (예: `@spfn/auth@0.4.0-beta.4`,
`@spfn/notification@0.3.0-beta.4`, `@spfn/auth@0.3.0-beta.53`, `spfn@0.4.0-beta.4`).
같은 버전을 다시 올릴 수는 없다. 그 버전의 lockfile 은 받은 레지스트리에서만 설치된다.

`v*` 태그로 core · spfn · cms · auth · monitor 다섯 패키지를 일괄 배포하던
`.github/workflows/publish.yml` 은 지웠다. 모두 `alpha` 태그로 배포하는 경로라 패키지별
워크플로우가 대체했고, 전 패키지를 같은 식으로 배포하던 루트 `package.json` 의
`publish:packages` · `publish:alpha` 스크립트도 함께 지웠다.
`RELEASE.md` 본문의 태그 기반 릴리스 절차도 같은 구 방식이라 더 이상 유효하지 않다.
