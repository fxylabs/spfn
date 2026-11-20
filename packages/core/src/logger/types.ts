/**
 * Logger Type Definitions
 *
 * 로깅 시스템 타입 정의
 *
 * ✅ 구현 완료:
 * - LogLevel 타입 정의
 * - LogMetadata 인터페이스
 * - Transport 인터페이스
 * - 환경별 설정 타입
 *
 * 🔗 관련 파일:
 * - src/logger/logger.ts (Logger 클래스)
 * - src/logger/transports/ (Transport 구현체)
 * - src/logger/config.ts (설정)
 */

import type { DatabaseErrorDescription, ErrorDescription } from './error-description';

/**
 * 로그 레벨
 * debug < info < warn < error < fatal
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/**
 * 로그 레벨 우선순위
 */
export const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    fatal: 4,
};

/**
 * 로그 메타데이터
 */
export interface LogMetadata
{
    timestamp: Date;
    level: LogLevel;
    message: string;
    module?: string;
    /** The logged error as `describeError` renders it — never the error object itself */
    error?: ErrorDescription | DatabaseErrorDescription;
    context?: Record<string, unknown>;
}

/**
 * Transport 인터페이스
 * 모든 Transport는 이 인터페이스를 구현해야 함
 */
export interface Transport
{
    /**
     * Transport 이름
     */
    name: string;

    /**
     * 최소 로그 레벨 (이 레벨 이상만 처리)
     */
    level: LogLevel;

    /**
     * 활성화 여부
     */
    enabled: boolean;

    /**
     * 로그 처리 함수
     */
    log(metadata: LogMetadata): Promise<void>;

    /**
     * Transport 종료 (리소스 정리)
     */
    close?(): Promise<void>;
}

/**
 * Logger 설정
 */
export interface LoggerConfig
{
    /**
     * 기본 로그 레벨
     */
    level: LogLevel;

    /**
     * 모듈명 (context)
     */
    module?: string;

    /**
     * Transport 리스트
     */
    transports: Transport[];
}

/**
 * Transport 설정 (공통)
 */
export interface TransportConfig
{
    level: LogLevel;
    enabled: boolean;
}

/**
 * Console Transport 설정
 */
export interface ConsoleTransportConfig extends TransportConfig
{
    colorize?: boolean;
}
