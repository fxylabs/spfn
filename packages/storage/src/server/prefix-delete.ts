/**
 * prefix 삭제 공통 드라이버 — 페이지를 받아 키 단위로 지운다.
 *
 * 배치 삭제(S3 `DeleteObjects`)를 쓰지 않는다: GCS interoperability 엔드포인트가 그 연산을
 * 지원하지 않아 S3 provider가 R2·SeaweedFS에서만 되는 코드가 되어버린다. 한 번에 한 페이지만
 * 들고 있으므로 객체가 수백만 개여도 메모리는 페이지 크기로 묶인다.
 */

import { errorMessage } from './delete-many';
import type { PrefixDeleteResult, StorageListResult } from '../shared/index';

const DELETE_CONCURRENCY = 8;

export async function deleteEveryListedObject(
    listPage: (cursor?: string) => Promise<StorageListResult>,
    deleteObject: (key: string) => Promise<void>,
): Promise<PrefixDeleteResult>
{
    const result: PrefixDeleteResult = { deleted: 0, failed: [] };
    let cursor: string | undefined;

    do
    {
        const page = await listPage(cursor);
        await deletePage(page.objects.map(object => object.key), deleteObject, result);
        cursor = page.cursor;
    }
    while (cursor);

    return result;
}

async function deletePage(
    keys: string[],
    deleteObject: (key: string) => Promise<void>,
    result: PrefixDeleteResult,
): Promise<void>
{
    for (let offset = 0; offset < keys.length; offset += DELETE_CONCURRENCY)
    {
        await Promise.all(keys.slice(offset, offset + DELETE_CONCURRENCY).map(async key =>
        {
            try
            {
                await deleteObject(key);
                result.deleted += 1;
            }
            catch (error)
            {
                result.failed.push({ key, error: errorMessage(error) });
            }
        }));
    }
}
