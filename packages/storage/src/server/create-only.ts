/**
 * create-only 쓰기(`ifAbsent`)의 실패 판정 — S3·GCS가 같은 규칙을 쓴다.
 *
 * 조건부 쓰기는 다시 보내면 안전하지 않다. 첫 시도가 저장된 뒤 응답만 사라지면 재시도는 412를 받고,
 * 그 412는 "내 첫 시도 때문에 있다"를 포함한다. 그래서 provider는 이 요청을 재시도 없는 클라이언트로
 * 한 번만 보내고, 그 한 번의 답만 판정한다.
 */

import { StorageObjectExistsError, StorageWriteOutcomeUnknownError } from '../shared/index';

/**
 * 요청이 나가지 않았음 → `null`(provider의 평소 오류 매핑에 맡긴다 — 아무것도 쓰이지 않았다).
 * 412 → 요청 전부터 key가 차 있었다(`StorageObjectExistsError`). 409를 뺀 4xx → 저장소가 거절해
 * 아무것도 쓰이지 않았다: `null`. 그 밖(응답 없음, 오류를 실은 2xx, S3 409 ConditionalRequestConflict,
 * 5xx) → 쓰였는지 모른다(`StorageWriteOutcomeUnknownError`).
 *
 * `sent`는 provider가 SDK에서 알 수 있는 만큼만 `false`다 — 모르면 `true`(보냈을 수 있다)로 둔다.
 */
export function createOnlyFailure(error: unknown, status: number | undefined, key: string, sent: boolean): Error | null
{
    if (!sent)
    {
        return null;
    }
    if (status === 412)
    {
        return new StorageObjectExistsError(key);
    }
    if (status !== undefined && status >= 400 && status < 500 && status !== 409)
    {
        return null;
    }

    return new StorageWriteOutcomeUnknownError(key, error);
}

/**
 * Node가 연결을 맺기 전 단계(DNS 조회 `getaddrinfo`, TCP `connect`)의 실패라고 알렸다 — 요청은 한
 * 바이트도 나가지 않았다. 연결을 맺은 뒤의 실패(ECONNRESET 등)와 TLS 핸드셰이크 실패는 여기에 들지
 * 않는다: 앞의 것은 보냈을 수 있고, 뒤의 것은 SDK가 단계를 알려 주지 않는다.
 */
export function failedBeforeConnecting(syscall: unknown): boolean
{
    return syscall === 'getaddrinfo' || syscall === 'connect';
}
