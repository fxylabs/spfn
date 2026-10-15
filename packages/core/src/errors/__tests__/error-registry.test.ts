/**
 * ErrorRegistry는 압축된 브라우저 번들에서도 `__type`으로 에러 클래스를 찾는다 (issue #131)
 *
 * 압축기는 클래스 바인딩 이름을 `Q`, `eA` 같은 짧은 이름으로 바꾸지만, 생성자가 `this.name`에
 * 넣는 문자열은 그대로 둔다. 압축되지 않은 서버는 `__type`에 원래 클래스 이름을 보내므로,
 * 브라우저에서 그 값과 맞는 것은 인스턴스가 스스로 정한 이름뿐이다.
 *
 * 아래 클래스들은 압축기가 내놓는 형태 그대로다: 바인딩 이름과 `this.name` 문자열이 다르다.
 */

import { describe, it, expect, afterAll } from 'vitest';

import { ErrorRegistry } from '../error-registry';
import type { SerializableErrorConstructor } from '../error-registry';
import { SerializableError } from '../serializable-error';
import * as httpErrors from '../http-errors';
import * as databaseErrors from '../database-errors';

const Q = class extends SerializableError
{
    readonly statusCode = 402;
    transactionId!: string;

    constructor(data: { message?: string; transactionId?: string } = {})
    {
        super(data.message ?? 'payment failed');
        this.name = 'PaymentFailedError';
        Object.assign(this, data);
    }
};

const eA = class extends SerializableError
{
    readonly statusCode = 400;

    constructor(data: { message?: string } = {})
    {
        super(data.message ?? 'order failed');
        this.name = 'OrderFailedError';
    }
};

// 자기 이름을 정하지 않은 하위 클래스: 인스턴스 이름은 부모의 것을 물려받는다
const tB = class extends eA
{
};

const nC = class extends eA
{
    constructor(data: { message?: string } = {})
    {
        super(data);
        this.name = 'OrderExpiredError';
    }
};

// 필드 없이는 만들 수 없는 생성자
const rD = class extends SerializableError
{
    readonly statusCode = 409;

    constructor(data: { conflict: { id: string } })
    {
        super(`conflict on ${data.conflict.id}`);
        this.name = 'ConflictOnIdError';
    }
};

describe('ErrorRegistry in a minified bundle', () =>
{
    it('restores a class by the name its instances carry, with its fields', () =>
    {
        const registry = new ErrorRegistry([Q]);

        const error = registry.deserialize({
            __type: 'PaymentFailedError',
            message: 'card declined',
            transactionId: 'tx_88',
        });

        expect(error).toBeInstanceOf(Q);
        expect(error.name).toBe('PaymentFailedError');
        expect((error as InstanceType<typeof Q>).transactionId).toBe('tx_88');
    });

    it('answers has() and tryDeserialize() by that name too', () =>
    {
        const registry = new ErrorRegistry([Q]);

        expect(registry.has('PaymentFailedError')).toBe(true);
        expect(registry.tryDeserialize({ __type: 'PaymentFailedError', message: 'm' })).toBeInstanceOf(Q);
    });

    it('keeps the constructor-name key', () =>
    {
        const registry = new ErrorRegistry([Q]);

        expect(registry.deserialize({ __type: 'Q', message: 'm' })).toBeInstanceOf(Q);
    });

    it('carries the names through concat', () =>
    {
        const registry = new ErrorRegistry([new ErrorRegistry([Q])]);

        expect(registry.deserialize({ __type: 'PaymentFailedError', message: 'm' })).toBeInstanceOf(Q);
    });

    it('never lets a subclass stand in for its parent by an inherited name, in either order', () =>
    {
        for (const classes of [[eA, tB], [tB, eA]])
        {
            const registry = new ErrorRegistry([classes]);
            const error = registry.deserialize({ __type: 'OrderFailedError', message: 'm' });

            expect(error.constructor).toBe(eA);
            expect(registry.deserialize({ __type: 'tB', message: 'm' }).constructor).toBe(tB);
        }
    });

    it('keys a subclass that names itself by its own name, leaving the parent its own', () =>
    {
        const registry = new ErrorRegistry([nC, eA]);

        expect(registry.deserialize({ __type: 'OrderExpiredError', message: 'm' }).constructor).toBe(nC);
        expect(registry.deserialize({ __type: 'OrderFailedError', message: 'm' }).constructor).toBe(eA);
    });

    it('registers a class that cannot be built without its fields under its constructor name only', () =>
    {
        const registry = new ErrorRegistry([rD]);

        expect(registry.has('ConflictOnIdError')).toBe(false);
        expect(registry.deserialize({ __type: 'rD', message: 'm', conflict: { id: '7' } })).toBeInstanceOf(rD);
    });
});

describe('ErrorRegistry outside a minified bundle', () =>
{
    class PaymentDeclinedError extends SerializableError
    {
        readonly statusCode = 402;

        constructor(data: { message?: string } = {})
        {
            super(data.message ?? 'declined');
            this.name = 'PaymentDeclinedError';
        }
    }

    // 생성자 이름이 `Y`인 클래스가 있을 때, 인스턴스 이름만 `Y`인 다른 클래스는 그 자리를 갖지 못한다
    const Y = class extends SerializableError
    {
        readonly statusCode = 400;

        constructor(data: { message?: string } = {})
        {
            super(data.message ?? 'y');
            this.name = 'Y';
        }
    };

    const Z = class extends SerializableError
    {
        readonly statusCode = 400;

        constructor(data: { message?: string } = {})
        {
            super(data.message ?? 'z');
            this.name = 'Y';
        }
    };

    it('lists a class whose two names agree once', () =>
    {
        expect(new ErrorRegistry([PaymentDeclinedError]).getRegisteredTypes()).toEqual(['PaymentDeclinedError']);
    });

    it('resolves the constructor name before the name an instance carries, in either order', () =>
    {
        for (const classes of [[Y, Z], [Z, Y]])
        {
            expect(new ErrorRegistry([classes]).deserialize({ __type: 'Y', message: 'm' }).constructor).toBe(Y);
        }
    });
});

describe('built-in errors in a minified bundle', () =>
{
    const builtIns = ([...Object.values(httpErrors), ...Object.values(databaseErrors)] as unknown[]).filter(
        (value): value is SerializableErrorConstructor =>
            typeof value === 'function' && value.prototype instanceof SerializableError,
    );
    const originalNames = new Map(builtIns.map(ErrorClass => [ErrorClass, ErrorClass.name]));

    afterAll(() =>
    {
        for (const [ErrorClass, name] of originalNames)
        {
            Object.defineProperty(ErrorClass, 'name', { value: name, configurable: true });
        }
    });

    it('restores every built-in class by the __type a server sends', () =>
    {
        builtIns.forEach((ErrorClass, index) =>
        {
            Object.defineProperty(ErrorClass, 'name', { value: `m${index}`, configurable: true });
        });

        const registry = new ErrorRegistry([builtIns]);

        expect(builtIns.length).toBeGreaterThan(15);

        for (const [ErrorClass, name] of originalNames)
        {
            expect(registry.deserialize({ __type: name, message: 'm' }).constructor).toBe(ErrorClass);
        }
    });
});
