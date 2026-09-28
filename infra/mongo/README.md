# MongoDB 배포

대상: 운영자가 지정한 Docker 호스트. 앱 로그인 계정 `admin / 1234`는 API 구현 시 생성한다. MongoDB 관리자 계정은 `memoryplace_root`이며 암호는 서버에서 별도 생성한다.

2026-09-28 현재 `memoryplace-mongo` 컨테이너가 실행 중이며 인증된 ping이 성공했다. 아래 명령은 재배포·운영 참고용이다.

`compose.yaml`을 서버의 운영 디렉터리에 복사한 뒤, 그 디렉터리에서 한 번만 실행:

```sh
export MEMORYPLACE_SECRET_DIR="<운영자가 정한 비공개 디렉터리>"
mkdir -p "$MEMORYPLACE_SECRET_DIR"
chmod 700 "$MEMORYPLACE_SECRET_DIR"
umask 077
openssl rand -base64 36 > "$MEMORYPLACE_SECRET_DIR/mongo_root_password"
docker compose -f compose.yaml up -d
```

상태 확인:

```sh
docker ps --filter name=memoryplace-mongo
docker exec memoryplace-mongo mongosh --quiet --eval 'db.adminCommand({ ping: 1 })'
```

MongoDB는 서버의 `127.0.0.1:27019`에만 바인딩된다. API를 같은 Docker Compose 프로젝트에 추가하면 내부 주소 `mongo:27017`을 사용한다. 원격 관리가 필요하면 SSH 포트 포워딩을 사용한다. 비밀번호 파일은 Git에 커밋하지 않는다. 명명 볼륨 `memoryplace_mongo_data`는 컨테이너 재생성 시에도 데이터를 유지한다.

운영 단계에서 앱 전용 최소 권한 DB 사용자를 따로 만들고 관리자 계정은 초기 설정에만 사용한다. 백업 대상은 이 볼륨의 DB 내용이며, 정기 백업과 복구 시험을 구성해야 한다.
