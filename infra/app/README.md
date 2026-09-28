# 운영 앱과 Jenkins

MemoryPlace 웹과 API는 하나의 Docker 이미지에서 실행한다. 앱 컨테이너는 기존 MongoDB의 `memoryplace_default` 내부 네트워크에 연결하고, 호스트의 `127.0.0.1:4301`에만 웹 포트를 연다. DB 포트는 외부에 공개하지 않는다.

## 최초 준비

운영 서버의 Docker에 `memoryplace_app_secrets` 볼륨을 만들고 `/mongo_url` 파일에 **앱 전용 계정**의 MongoDB URI를 저장한다. URI의 호스트는 같은 Docker 네트워크의 `mongo:27017`이어야 한다. 파일은 컨테이너 사용자(UID 1000)만 읽을 수 있게 한다. 비밀번호 값과 운영 서버 경로는 Git에 넣지 않는다. 앱은 `MONGO_URL_FILE=/run/secrets/mongo_url`에서 이 값을 읽는다.

Jenkins 작업은 이 저장소의 `Jenkinsfile` 내용을 **Pipeline script**로 등록한다. Jenkins 실행 환경에는 Docker CLI와 Docker 소켓 접근 권한이 필요하다. 파이프라인은 `main`을 내려받아 다음을 실행한다.

1. `Dockerfile`의 `build` 단계를 빌드해 TypeScript 검사와 웹 번들링을 실행한다.
2. 일회용 MongoDB와 네트워크를 만들어 API 통합 테스트를 실행한 뒤 정리한다.
3. 운영 이미지를 빌드한다.
4. `DEPLOY_AFTER_BUILD`가 켜져 있으면 [배포 스크립트](../../scripts/deploy.sh)로 앱 컨테이너를 교체하고 Docker 상태 검사가 통과했는지 확인한다. 실패 시 직전 이미지를 복원한다.

배포 스크립트는 `memoryplace_default` 네트워크와 `memoryplace_app_secrets` 볼륨이 존재해야 실행된다. 이 이름은 기존 MongoDB 배포와 맞춘 것이므로 다른 Docker 환경에서는 스크립트를 수정한다. 앱 설정은 Docker 읽기 전용 볼륨에서 공급하며 이미지에는 포함되지 않는다.

## Tailscale에서 접속

클라이언트 기기를 같은 tailnet에 연결한다. 운영 서버에서 앱이 로컬 4301 포트에 실행되는 것을 확인한 뒤, 기존 443 포트의 다른 서비스를 건드리지 않고 별도 HTTPS 포트를 추가한다.

```sh
tailscale serve --bg --https=8443 4301
tailscale serve status
```

접속 URL은 `https://<서버 이름>.<tailnet>.ts.net:8443/`이다. Tailscale의 `100.x.y.z` 주소는 인터넷 공개 IP가 아니며, 브라우저에서 IP를 HTTP로 여는 방식은 운영 환경의 `Secure` 로그인 쿠키와 맞지 않는다. HTTPS 이름으로 접속하면 Tailscale이 인증서를 제공한다. 서버에서 이미 사용 중인 Serve·Funnel 설정이 있다면 `tailscale serve reset`을 실행하지 않는다.

## 확인

```sh
docker ps --filter name=memoryplace-app
curl -fsS http://127.0.0.1:4301/api/health
```

`{"ok":true}`가 나오면 앱과 DB 연결이 정상이다. Jenkins의 **Build with Parameters**에서 배포 여부를 선택할 수 있다. `admin / 1234`는 첫 앱 계정이며 첫 로그인 직후 비밀번호 변경 화면이 나타난다.
