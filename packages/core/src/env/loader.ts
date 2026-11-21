/**
 * Environment Variable Loader
 *
 * Next.js 스타일의 환경변수 파일 로딩 (환경별 분리 지원)
 *
 * 로딩 우선순위 (낮음 -> 높음, 나중 파일이 덮어씀):
 * 1. .env                   - 기본값 (committed)
 * 2. .env.{NODE_ENV}        - 환경별 오버라이드 (committed)
 * 3. .env.local             - 로컬 오버라이드 (gitignored, test에서 스킵)
 * 4. .env.{NODE_ENV}.local  - 환경별 시크릿 (gitignored)
 * 5. .env.server            - 서버 전용 (gitignored, Next.js 미로드)
 *
 * @example
 * ```typescript
 * import { loadEnv } from '@spfn/core/env/loader';
 *
 * // 기본 사용 (NODE_ENV 자동 감지)
 * loadEnv();
 *
 * // 특정 환경 지정
 * loadEnv({ nodeEnv: 'production' });
 *
 * // 서버 레이어 제외 (Next.js 클라이언트용)
 * loadEnv({ server: false });
 * ```
 *
 * @module env/loader
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { logger } from '@spfn/core/logger';
import { DATABASE_OWNER_URL } from '../config/schema';

const envLogger = logger.child('@spfn/core:env-loader');

/**
 * loadEnv 옵션
 */
export interface LoadEnvOptions
{
    /**
     * 프로젝트 루트 경로
     * @default process.cwd()
     */
    cwd?: string;

    /**
     * NODE_ENV 값 (환경별 .env 파일 결정)
     * @default process.env.NODE_ENV || 'local'
     */
    nodeEnv?: string;

    /**
     * 서버 전용 파일 포함 여부 (.env.server)
     * @default true
     */
    server?: boolean;

    /**
     * 디버그 모드 (로드된 파일 로깅)
     * @default false
     */
    debug?: boolean;

    /**
     * 기존 process.env 값 덮어쓰기 허용
     * @default false
     */
    override?: boolean;

    /**
     * Load `DATABASE_OWNER_URL` from the files too. The table owner's URL is
     * for the spfn commands that change the schema, and only they pass this;
     * every other caller — the server, its provisioning, app code, a later
     * reload — leaves the key out of `process.env`, and the first such load in
     * a process logs one `debug` line naming the file (never the value). A
     * value the process inherited is not this loader's: the server entries
     * remove that.
     * @default false
     */
    ownerCredentials?: boolean;
}

/**
 * 환경변수 로드 결과
 */
export interface LoadEnvResult
{
    /**
     * 로드된 파일 목록
     */
    loadedFiles: string[];

    /**
     * 로드된 환경변수 키 목록
     */
    loadedKeys: string[];
}

/** Whether this process has said that a file's `DATABASE_OWNER_URL` was left out. */
let ownerUrlSkipReported = false;

/**
 * NODE_ENV에 따른 .env 파일 목록 생성 (우선순위 낮음 -> 높음)
 *
 * 더 구체적인 파일이 승리:
 * - environment > base
 * - server > shared
 * - local > committed
 */
function getEnvFiles(nodeEnv: string, server: boolean): string[]
{
    const files: string[] = [
        '.env',
        `.env.${nodeEnv}`,
    ];

    // test 환경에서는 .env.local 스킵 (테스트 결정론성 보장)
    if (nodeEnv !== 'test')
    {
        files.push('.env.local');
    }

    files.push(`.env.${nodeEnv}.local`);

    if (server)
    {
        files.push('.env.server');
    }

    return files;
}

/**
 * 단일 .env 파일 파싱
 */
function parseEnvFile(filePath: string): Record<string, string> | null
{
    if (!existsSync(filePath))
    {
        return null;
    }

    return parse(readFileSync(filePath, 'utf-8'));
}

/**
 * 프로젝트 루트의 환경변수 파일들을 규칙에 따라 로드
 *
 * 모든 파일을 파싱 후 머지한 뒤 process.env에 한번에 적용.
 * 이미 process.env에 존재하는 키는 덮어쓰지 않음 (플랫폼 주입 보호).
 *
 * @param options - 로드 옵션
 * @returns 로드 결과 (로드된 파일, 키 목록)
 */
export function loadEnv(options: LoadEnvOptions = {}): LoadEnvResult
{
    // Captured before any file is read: NODE_ENV decides WHICH files load, so a
    // value that only arrives from inside a file arrives too late to matter.
    const nodeEnvAtEntry = process.env.NODE_ENV;

    const {
        cwd = process.cwd(),
        nodeEnv = nodeEnvAtEntry || 'local',
        server = true,
        debug = false,
        override = false,
        ownerCredentials = false,
    } = options;

    const envFiles = getEnvFiles(nodeEnv, server);
    const loadedFiles: string[] = [];

    // 1) 기존 process.env 키 스냅샷 저장
    const existingKeys = new Set(Object.keys(process.env));

    // 2) 모든 .env 파일 파싱 후 머지 (나중 파일이 승리)
    const merged: Record<string, string> = {};
    let ownerUrlFile: string | undefined;

    for (const fileName of envFiles)
    {
        const filePath = resolve(cwd, fileName);
        const parsed = parseEnvFile(filePath);

        if (parsed === null)
        {
            continue;
        }

        loadedFiles.push(fileName);
        Object.assign(merged, parsed);

        if (DATABASE_OWNER_URL in parsed)
        {
            ownerUrlFile = fileName;
        }
    }

    if (!ownerCredentials && ownerUrlFile !== undefined)
    {
        delete merged[DATABASE_OWNER_URL];
        reportOwnerUrlSkipped(ownerUrlFile, override || !existingKeys.has(DATABASE_OWNER_URL));
    }

    // 3) 머지된 결과를 process.env에 적용
    const loadedKeys: string[] = [];

    for (const [key, value] of Object.entries(merged))
    {
        // 기존 process.env에 이미 있는 키는 스킵 (override가 false일 때)
        if (!override && existingKeys.has(key))
        {
            continue;
        }

        process.env[key] = value;
        loadedKeys.push(key);
    }

    if (debug && loadedFiles.length > 0)
    {
        envLogger.debug(`Loaded env files: ${loadedFiles.join(', ')}`);
        envLogger.debug(`Loaded ${loadedKeys.length} environment variables`);
    }

    warnIfEnvGuessCostSomething(cwd, nodeEnvAtEntry, options.nodeEnv, nodeEnv);

    return { loadedFiles, loadedKeys };
}

/**
 * Say, once per process, that `file`'s `DATABASE_OWNER_URL` was left out.
 *
 * Logged at `debug`: nothing is wrong and nothing is to do — keeping the
 * owner's URL in a file the CLI reads is how local development gives it to the
 * schema commands — so a correct configuration boots without a line, and the
 * line is there for whoever wonders why the server does not hold the variable
 * (`SPFN_LOG_LEVEL=debug`; the env README states the behaviour). Silent when the
 * file's value would not have applied anyway — the process already holds the
 * variable (an owner command's earlier load), which is not this file's doing.
 *
 * @param file - the last file that sets the key
 * @param wouldHaveApplied - whether the value would have reached `process.env`
 */
function reportOwnerUrlSkipped(file: string, wouldHaveApplied: boolean): void
{
    if (ownerUrlSkipReported || !wouldHaveApplied)
    {
        return;
    }

    ownerUrlSkipReported = true;
    envLogger.debug(
        `${DATABASE_OWNER_URL} is in ${file}; the server does not load it;`
        + ' spfn db commands that change the schema do.',
    );
}

/**
 * Warn when guessing NODE_ENV actually cost the caller something.
 *
 * `getEnvFiles` runs before any file is parsed, so NODE_ENV decides WHICH files
 * load and a value set inside .env.server arrives too late to affect that. The
 * warning therefore reports a missed file, not a missing variable — the previous
 * version announced the variable itself and fired on every boot of a correctly
 * configured app (issue #136).
 *
 * Silent when the guess cost nothing: the guess matched what the files declare,
 * or it did not match but no `.env.<declared>` file exists to have been skipped.
 *
 * @param cwd - project root the files were resolved against
 * @param nodeEnvAtEntry - NODE_ENV as the process was started with
 * @param explicitNodeEnv - nodeEnv passed by the caller, if any
 * @param resolvedNodeEnv - the value the file list was actually built from
 */
function warnIfEnvGuessCostSomething(
    cwd: string,
    nodeEnvAtEntry: string | undefined,
    explicitNodeEnv: string | undefined,
    resolvedNodeEnv: string,
): void
{
    // Nothing was guessed — the process or the caller named the environment.
    if (nodeEnvAtEntry || explicitNodeEnv)
    {
        return;
    }

    const declared = process.env.NODE_ENV;

    if (!declared)
    {
        envLogger.warn(
            `NODE_ENV is not set anywhere; env files were resolved for "${resolvedNodeEnv}".`
            + ' Set NODE_ENV in the process environment to choose the file set.',
        );

        return;
    }

    if (declared === resolvedNodeEnv)
    {
        return;
    }

    // The guess was wrong, but a file set only goes missing if the file exists.
    if (!existsSync(resolve(cwd, `.env.${declared}`)))
    {
        return;
    }

    envLogger.warn(
        `.env.${declared} was NOT loaded: NODE_ENV was not set when the process started,`
        + ` so env files were resolved for "${resolvedNodeEnv}" before a file declared`
        + ` NODE_ENV=${declared}. Set NODE_ENV in the process environment, not in a .env file.`,
    );
}

/**
 * 환경변수가 이미 로드되었는지 확인하는 플래그
 */
let isEnvLoaded = false;

/**
 * 환경변수를 한 번만 로드 (중복 호출 방지)
 *
 * @param options - 로드 옵션
 * @returns 로드 결과 (이미 로드된 경우 빈 결과)
 */
export function loadEnvOnce(options: LoadEnvOptions = {}): LoadEnvResult
{
    if (isEnvLoaded)
    {
        return { loadedFiles: [], loadedKeys: [] };
    }

    isEnvLoaded = true;

    return loadEnv(options);
}

/**
 * 환경변수 로드 상태 리셋 (테스트용)
 */
export function resetEnvLoadState(): void
{
    isEnvLoaded = false;
    ownerUrlSkipReported = false;
}
