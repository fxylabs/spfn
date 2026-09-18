/**
 * provider 호출 전 입력 검증 — 키·프리픽스·페이지 크기.
 *
 * 로컬 provider가 키를 파일 경로로 그대로 쓰므로 traversal을 여기서 끊고, S3·GCS에서도
 * 같은 키가 같은 판정을 받게 한다. 세그먼트 개수 제한이나 문자 화이트리스트 같은 정책은
 * 앱이 정한다 — 여기서는 어느 provider에서도 위험하거나 의미가 갈리는 형태만 거부한다.
 */

import { StorageKeyError } from '../shared/index';

/** S3·GCS 공통 키 길이 상한(UTF-8 바이트). */
const MAX_KEY_BYTES = 1024;
const URL_KEY_PATTERN = /^[a-z][a-z\d+.-]*:\/\//i;
const DEFAULT_MAX_KEYS = 1000;
const MAX_ECHOED_CHARS = 128;

export function assertObjectKey(key: string): void
{
    assertValid('key', key);
}

/** 프리픽스도 키와 같은 규칙. 빈 문자열·`/`는 버킷 전체를 뜻하게 되므로 특히 거부된다. */
export function assertKeyPrefix(prefix: string): void
{
    assertValid('prefix', prefix);
}

/** 개수·동시성처럼 양의 정수만 뜻이 있는 옵션의 공통 판정. */
export function assertPositiveInteger(label: string, value: number): void
{
    if (!Number.isInteger(value) || value <= 0)
    {
        throw new StorageKeyError(`Invalid ${label}: must be a positive integer, got ${value}`);
    }
}

/** `list`의 페이지 크기. 미지정이면 1,000. */
export function resolveMaxKeys(maxKeys?: number): number
{
    if (maxKeys === undefined)
    {
        return DEFAULT_MAX_KEYS;
    }
    assertPositiveInteger('maxKeys', maxKeys);

    return maxKeys;
}

/** 키 정렬 비교자 — 로컬 provider의 커서가 provider 간과 같은 순서를 쓰게 한다. */
export function compareKeys(left: string, right: string): number
{
    if (left === right)
    {
        return 0;
    }

    return left < right ? -1 : 1;
}

function assertValid(label: string, value: string): void
{
    const message = violationMessage(label, value);
    if (message)
    {
        throw new StorageKeyError(message);
    }
}

function violationMessage(label: string, value: string): string | null
{
    if (typeof value !== 'string' || value.length === 0)
    {
        return `Invalid storage ${label}: must be a non-empty string`;
    }
    // 서명 URL을 그대로 되돌리면 서명이 로그에 남는다 — URL과 제어문자는 값을 echo하지 않는다.
    if (URL_KEY_PATTERN.test(value) || value.startsWith('//'))
    {
        return `Invalid storage ${label}: requires a storage key, not a URL`;
    }
    if (hasControlCharacter(value))
    {
        return `Invalid storage ${label}: must not contain control characters`;
    }

    const detail = shapeViolation(value);

    return detail ? `Invalid storage ${label}: ${truncate(value)} — ${detail}` : null;
}

function shapeViolation(value: string): string | null
{
    if (value.startsWith('/'))
    {
        return 'must be relative, without a leading "/"';
    }
    if (value.includes('\\'))
    {
        return 'must use "/" separators, without a backslash';
    }
    if (Buffer.byteLength(value, 'utf8') > MAX_KEY_BYTES)
    {
        return `must be at most ${MAX_KEY_BYTES} UTF-8 bytes`;
    }

    return segmentViolation(value);
}

function segmentViolation(value: string): string | null
{
    for (const segment of value.split('/'))
    {
        if (segment.length === 0)
        {
            return 'must not contain an empty path segment';
        }
        if (segment === '.' || segment === '..')
        {
            return 'must not contain a "." or ".." path segment';
        }
    }

    return null;
}

function hasControlCharacter(value: string): boolean
{
    for (let index = 0; index < value.length; index += 1)
    {
        const code = value.charCodeAt(index);
        if (code < 0x20 || code === 0x7f)
        {
            return true;
        }
    }

    return false;
}

function truncate(value: string): string
{
    return value.length > MAX_ECHOED_CHARS ? `${value.slice(0, MAX_ECHOED_CHARS)}…` : value;
}
