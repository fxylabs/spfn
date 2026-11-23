/**
 * 조건부 쓰기만 받는 가짜 저장소 엔드포인트 — 응답이 사라진 create-only 쓰기를 재현한다.
 *
 * 비어 있는 key로 온 첫 쓰기는 저장한 뒤 응답 없이 소켓을 끊는다(첫 시도는 저장됐고 응답만 유실).
 * 차 있는 key로 온 쓰기에는 provider 형식의 412로 답한다. 조건이 없는 요청은 400이다 — 행이
 * 조건을 보냈는지도 함께 확인한다.
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface ConditionalWriteDialect
{
    /** 조건부 쓰기의 대상 key. 조건이 없는 요청이면 `null`. */
    targetOf(request: IncomingMessage, url: URL): string | null;
    answerTaken(response: ServerResponse): void;
}

export interface ConditionalWriteEndpoint
{
    url: string;
    /** 받은 조건부 쓰기의 대상 key, 도착 순서대로. */
    writes: string[];
    close(): Promise<void>;
}

export async function startConditionalWriteEndpoint(
    dialect: ConditionalWriteDialect,
    taken: string[] = [],
): Promise<ConditionalWriteEndpoint>
{
    const stored = new Set(taken);
    const writes: string[] = [];
    const server = createServer((request, response) =>
    {
        request.resume();
        request.on('end', () =>
        {
            const target = dialect.targetOf(request, new URL(request.url ?? '/', 'http://endpoint'));
            if (target === null)
            {
                response.writeHead(400).end();

                return;
            }
            writes.push(target);
            if (stored.has(target))
            {
                dialect.answerTaken(response);

                return;
            }
            stored.add(target);
            request.socket.destroy();
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        writes,
        close: () => new Promise(resolve =>
        {
            server.closeAllConnections();
            server.close(() => resolve());
        }),
    };
}
