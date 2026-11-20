/**
 * @spfn/monitor - Error Tracking Service Tests
 *
 * Tests error tracking state transitions with mocked repositories
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock repositories before importing service
vi.mock('../../server/repositories', () =>
{
    const mockErrorGroupsRepo = {
        findByFingerprint: vi.fn(),
        create: vi.fn(),
        incrementCount: vi.fn(),
        updateStatus: vi.fn(),
        reactivate: vi.fn(),
    };

    const mockErrorEventsRepo = {
        create: vi.fn(),
    };

    return {
        errorGroupsRepository: mockErrorGroupsRepo,
        errorEventsRepository: mockErrorEventsRepo,
    };
});

// Mock notifier
vi.mock('../../server/notifiers/slack', () => ({
    notifyErrorToSlack: vi.fn().mockResolvedValue(undefined),
}));

import { trackError } from '../../server/services/error-tracking.service';
import { errorGroupsRepository, errorEventsRepository } from '../../server/repositories';
import { notifyErrorToSlack } from '../../server/notifiers/slack';

const mockCtx = {
    statusCode: 500,
    path: '/api/test',
    method: 'GET',
    requestId: 'req-123',
    environment: 'test',
};

const mockGroup = {
    id: 1,
    fingerprint: 'abc123',
    name: 'Error',
    message: 'test error',
    path: '/api/test',
    method: 'GET',
    statusCode: 500,
    status: 'active' as const,
    count: 5,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    resolvedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
};

const mockEvent = {
    id: 1,
    groupId: 1,
    requestId: 'req-123',
    userId: null,
    statusCode: 500,
    headers: null,
    query: null,
    stackTrace: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
};

describe('trackError', () =>
{
    beforeEach(() =>
    {
        vi.clearAllMocks();
        (errorEventsRepository.create as any).mockResolvedValue(mockEvent);
    });

    it('should create new group + event + notify for new errors', async () =>
    {
        (errorGroupsRepository.findByFingerprint as any).mockResolvedValue(null);
        (errorGroupsRepository.create as any).mockResolvedValue(mockGroup);

        await trackError(new Error('test error'), mockCtx);

        expect(errorGroupsRepository.create).toHaveBeenCalledTimes(1);
        expect(errorEventsRepository.create).toHaveBeenCalledTimes(1);
        expect(notifyErrorToSlack).toHaveBeenCalledWith(
            mockGroup,
            mockEvent,
            expect.objectContaining({ kind: 'error', name: 'Error' }),
            'new',
            'test',
        );
    });

    it('should increment count for active errors without notifying', async () =>
    {
        (errorGroupsRepository.findByFingerprint as any).mockResolvedValue(mockGroup);

        await trackError(new Error('test error'), mockCtx);

        expect(errorGroupsRepository.incrementCount).toHaveBeenCalledWith(1);
        expect(errorEventsRepository.create).toHaveBeenCalledTimes(1);
        expect(notifyErrorToSlack).not.toHaveBeenCalled();
    });

    it('should increment count for ignored errors without notifying', async () =>
    {
        (errorGroupsRepository.findByFingerprint as any).mockResolvedValue({
            ...mockGroup,
            status: 'ignored',
        });

        await trackError(new Error('test error'), mockCtx);

        expect(errorGroupsRepository.incrementCount).toHaveBeenCalledWith(1);
        expect(notifyErrorToSlack).not.toHaveBeenCalled();
    });

    it('should reopen resolved errors and notify', async () =>
    {
        (errorGroupsRepository.findByFingerprint as any).mockResolvedValue({
            ...mockGroup,
            status: 'resolved',
        });

        await trackError(new Error('test error'), mockCtx);

        expect(errorGroupsRepository.reactivate).toHaveBeenCalledWith(1);
        expect(errorEventsRepository.create).toHaveBeenCalledTimes(1);
        expect(notifyErrorToSlack).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'active' }),
            mockEvent,
            expect.objectContaining({ kind: 'error', name: 'Error' }),
            'reopened',
            'test',
        );
    });

    it('should pass metadata to event creation', async () =>
    {
        (errorGroupsRepository.findByFingerprint as any).mockResolvedValue(null);
        (errorGroupsRepository.create as any).mockResolvedValue(mockGroup);

        const metadata = { env: 'production', region: 'us-east-1' };
        await trackError(new Error('test error'), mockCtx, metadata);

        expect(errorEventsRepository.create).toHaveBeenCalledWith(
            expect.objectContaining({ metadata }),
        );
    });
});
