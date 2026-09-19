import { DEFAULT_EXPIRES_IN } from '../shared/index';
import type { DownloadUrlOptions } from '../shared/index';

/** `getDownloadUrl(key, 900)`과 `getDownloadUrl(key, { … })` 두 꼴을 한 모양으로. */
export function downloadUrlOptions(options: number | DownloadUrlOptions | undefined): Required<Pick<DownloadUrlOptions, 'expiresIn'>> & DownloadUrlOptions
{
    if (typeof options === 'number')
    {
        return { expiresIn: options };
    }

    return { ...options, expiresIn: options?.expiresIn ?? DEFAULT_EXPIRES_IN };
}

/** local provider의 URL 뒤에 붙는 쿼리 — S3·GCS가 서명에 넣는 두 응답 헤더의 이름 그대로. */
export function responseHeaderQuery(options: DownloadUrlOptions): string
{
    const query = new URLSearchParams();
    if (options.responseContentDisposition)
    {
        query.set('response-content-disposition', options.responseContentDisposition);
    }
    if (options.responseContentType)
    {
        query.set('response-content-type', options.responseContentType);
    }
    const text = query.toString();

    return text ? `?${text}` : '';
}
