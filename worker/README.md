# ttreport-worker

`https://ttreport.connectnai.com` 에서 **교육 출석부 & 일지**(`index.html`)를 제공하는 Cloudflare Worker입니다.

## 무엇을 하나요

- GitHub 저장소 `JINSU9161/TTreport` (브랜치 `main`)의 `index.html`을 GitHub API로 가져옵니다.
  저장소가 비공개(private)여도 읽기 전용 토큰(`GITHUB_TOKEN`)으로 가져올 수 있습니다.
- 파일 내용은 그대로 두고 **응답 헤더만 조정해서** 내보냅니다.
  - `Content-Type: text/html; charset=utf-8`, `Cache-Control: no-cache`
  - 보안 헤더: `Content-Security-Policy`, `Strict-Transport-Security`, `X-Frame-Options: DENY`,
    `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`,
    `X-Robots-Tag: noindex, nofollow` (검색엔진 노출 방지)
  - GitHub 쪽 응답 헤더(`x-github-*`, `set-cookie` 등)는 하나도 전달하지 않습니다.
- 가져온 HTML은 Cloudflare 엣지에 `CACHE_TTL`초(기본 300초 = 5분) 동안 캐시합니다.
  GitHub에 장애가 있거나 응답이 8초 넘게 없으면 마지막으로 캐시된 사본을 보여주고,
  사본도 없으면 짧은 안내 페이지(503)를 보여줍니다. 토큰이나 GitHub 오류 내용은 절대 사용자에게 노출되지 않습니다.
- 경로
  - `/`, `/index.html` → 앱 페이지 (GET, HEAD)
  - `/healthz` → `ok` (상태 확인용)
  - 그 외 경로 → 404, GET/HEAD 이외의 메서드 → 405

## 무료 플랜 한도

- Cloudflare Workers 무료 플랜: **하루 100,000 요청**, 요청당 CPU 10ms.
  이 Worker는 캐시된 HTML을 돌려주기만 하므로 CPU 사용량이 매우 작습니다.
  한도를 넘으면 그날은 오류 페이지가 표시되며, 매일 0시(UTC, 한국시간 오전 9시)에 초기화됩니다.
- Custom Domain, Cache API, Secret 모두 무료 플랜에서 사용할 수 있습니다. 결제 정보 등록은 필요 없습니다.
- GitHub API는 토큰 사용 시 시간당 5,000회까지 허용됩니다. 캐시 덕분에 실제 GitHub 호출은
  Cloudflare 데이터센터별로 5분에 한 번 정도이며, 내용이 바뀌지 않았으면 `304 Not Modified`로 처리되어 한도를 거의 쓰지 않습니다.

## 배포 순서 (처음 한 번)

> 아래 명령은 모두 이 폴더(`C:\ttreport\ttreport-worker`)에서 실행합니다. Node.js가 설치되어 있어야 합니다.

### 1. GitHub 읽기 전용 토큰 만들기 (Fine-grained personal access token)

1. GitHub 로그인 → 오른쪽 위 프로필 → **Settings** → 왼쪽 맨 아래 **Developer settings**
   → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**
2. 다음과 같이 설정합니다.
   - **Token name**: `ttreport-worker` (아무 이름이나 가능)
   - **Expiration**: 만료일을 지정합니다 (예: 90일 또는 1년). 무기한은 권장하지 않습니다.
   - **Resource owner**: `JINSU9161`
   - **Repository access**: **Only select repositories** → `TTreport` 하나만 선택
   - **Permissions → Repository permissions → Contents**: **Read-only**
     (Metadata: Read-only 는 자동으로 같이 선택됩니다. 다른 권한은 주지 마세요.)
3. **Generate token**을 누르고 표시된 토큰(`github_pat_...`)을 복사해 둡니다. 이 화면을 벗어나면 다시 볼 수 없습니다.

> **만료 전에 꼭 교체하세요.** 토큰이 만료되면 캐시된 사본이 사라진 뒤부터 사이트가 503 안내 페이지를 보여줍니다.
> 만료일을 달력에 적어 두고, 만료 전에 새 토큰을 만들어 4단계(`wrangler secret put`)만 다시 실행하면 됩니다(재배포 불필요).
> GitHub도 만료 7일 전쯤 이메일로 알려줍니다.

### 2. 패키지 설치

```powershell
npm install
```

(`allow-scripts` 관련 경고가 나와도 그대로 진행해도 됩니다.)

### 3. Cloudflare 로그인

```powershell
npx wrangler login
```

브라우저가 열리면 **`connectnai.com` 도메인이 등록된 Cloudflare 계정**으로 로그인하고 권한을 허용합니다.
`npx wrangler whoami` 로 올바른 계정인지 확인할 수 있습니다.

### 4. GitHub 토큰을 Secret으로 등록

```powershell
npx wrangler secret put GITHUB_TOKEN
```

프롬프트에 1단계에서 복사한 토큰을 붙여넣고 Enter. 토큰은 Cloudflare에 암호화되어 저장되며 코드나 파일에는 남지 않습니다.
(Worker가 아직 없으면 "새 Worker를 만들까요?" 라고 물을 수 있습니다. `Y`를 선택하세요.)

### 5. 배포

```powershell
npx wrangler deploy
```

- `wrangler.toml`의 `custom_domain = true` 설정 덕분에 `ttreport.connectnai.com` **DNS 레코드와 HTTPS 인증서가 자동으로 생성**됩니다.
- **주의:** Cloudflare DNS에 이미 `ttreport` 라는 이름의 레코드(CNAME/A 등, 예: GitHub Pages용 CNAME)가 있으면 배포가 실패합니다.
  Cloudflare 대시보드 → `connectnai.com` → **DNS** → **Records** 에서 `ttreport` 레코드를 먼저 삭제한 뒤 다시 배포하세요.
- 인증서 발급에 몇 분 걸릴 수 있습니다.

### 6. 동작 확인

브라우저로 https://ttreport.connectnai.com 을 열어 앱이 정상적으로 열리는지, 로그인/조회/엑셀 내보내기가 되는지 확인합니다.

```powershell
curl.exe -I https://ttreport.connectnai.com/
curl.exe https://ttreport.connectnai.com/healthz
```

첫 번째 명령 결과에 `HTTP/1.1 200`, `content-security-policy` 등이 보이면 정상입니다.
문제가 있으면 `npm run tail` 로 실시간 로그를 볼 수 있습니다 (예: `github fetch failed 401` → 토큰 문제).

### 7. GitHub 저장소를 비공개로 전환

**6단계에서 정상 동작을 확인한 다음에만** 진행합니다.
GitHub → `JINSU9161/TTreport` → **Settings** → 맨 아래 **Danger Zone** → **Change repository visibility** → **Make private**.

전환 후 GitHub Pages 주소는 더 이상 동작하지 않으며, 사용자에게는 `https://ttreport.connectnai.com` 주소를 안내하면 됩니다.
전환 직후 다시 한번 https://ttreport.connectnai.com 이 열리는지 확인하세요.

## 업데이트는 어떻게 반영되나요

1. 평소처럼 `index.html`을 수정해서 `main` 브랜치에 push 합니다.
2. 최대 `CACHE_TTL`(기본 5분) 안에 사이트에 반영됩니다. 재배포는 필요 없습니다.
   - 브라우저는 `Cache-Control: no-cache` 라서 매번 새 버전이 있는지 확인합니다.
   - 반영 주기를 바꾸려면 `wrangler.toml`의 `CACHE_TTL` 값을 바꾸고 `npx wrangler deploy` 하세요.
3. Worker 코드(`src/index.js`)나 설정을 바꾼 경우에만 `npx wrangler deploy`를 다시 실행합니다.

## 로컬 테스트

```powershell
npm run dev
```

http://127.0.0.1:8787 에서 확인할 수 있습니다. 저장소가 공개 상태일 때는 토큰 없이 동작합니다.
비공개 전환 후 로컬 테스트를 하려면 이 폴더에 `.dev.vars` 파일을 만들고 `GITHUB_TOKEN=github_pat_...` 한 줄을 넣으세요
(`.gitignore`에 포함되어 있어 git에 올라가지 않습니다).

## 대안: 기존 connectnai.com Worker에 경로만 추가하기

이미 `connectnai.com`에서 쓰고 있는 Worker가 있고 그쪽에 합치고 싶다면:

1. `src/index.js`의 `serveIndex`, `fetchFromGitHub`, `cacheEntry`, `htmlResponse`, `unavailable` 등 함수와
   상단 상수(`CSP`, `SECURITY_HEADERS` 등)를 기존 Worker에 복사합니다.
2. 기존 Worker의 `fetch` 핸들러에서 `url.hostname === "ttreport.connectnai.com"` 인 요청을 이 코드로 넘기도록 분기합니다.
3. 기존 Worker의 `wrangler.toml`에 `[vars]`(GITHUB_OWNER/REPO/BRANCH, CACHE_TTL)와 라우트
   `{ pattern = "ttreport.connectnai.com", custom_domain = true }` 를 추가하고,
   그 Worker에 `npx wrangler secret put GITHUB_TOKEN` 으로 토큰을 등록한 뒤 배포합니다.

단, 별도 Worker로 두는 편이 관리와 장애 분리 면에서 더 단순하므로 특별한 이유가 없으면 이 프로젝트를 그대로 쓰는 것을 권장합니다.
