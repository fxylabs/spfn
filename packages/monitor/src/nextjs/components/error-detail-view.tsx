/**
 * @spfn/monitor - Error Detail View Component
 *
 * Shows error group details with event timeline and status change buttons
 */

import { useState, useEffect, useCallback } from 'react';
import { monitorApi } from '@spfn/monitor';
import type { ErrorGroupStatus } from '@spfn/monitor';
import { eventPreview } from './event-preview';

interface ErrorDetailViewProps
{
    errorId: number;
    onBack?: () => void;
}

const STATUS_ACTIONS: Record<ErrorGroupStatus, { label: string; target: ErrorGroupStatus }[]> = {
    active: [
        { label: 'Resolve', target: 'resolved' },
        { label: 'Ignore', target: 'ignored' },
    ],
    resolved: [
        { label: 'Reopen', target: 'active' },
    ],
    ignored: [
        { label: 'Reopen', target: 'active' },
        { label: 'Resolve', target: 'resolved' },
    ],
};

export function ErrorDetailView({ errorId, onBack }: ErrorDetailViewProps)
{
    const [data, setData] = useState<any>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isMutating, setIsMutating] = useState(false);

    const fetchDetail = useCallback(async () =>
    {
        setIsLoading(true);
        try
        {
            const result = await monitorApi.getErrorDetail.call({ params: { id: errorId } });
            setData(result);
        }
        finally
        {
            setIsLoading(false);
        }
    }, [errorId]);

    useEffect(() =>
    {
        fetchDetail();
    }, [fetchDetail]);

    async function handleStatusChange(status: string)
    {
        setIsMutating(true);
        try
        {
            await monitorApi.updateErrorStatus.call({
                params: { id: errorId },
                body: { status },
            });
            await fetchDetail();
        }
        finally
        {
            setIsMutating(false);
        }
    }

    if (isLoading || !data)
    {
        return <div className="text-sm text-neutral-500">Loading...</div>;
    }

    const { group, events } = data;
    const actions = STATUS_ACTIONS[group.status as ErrorGroupStatus] ?? [];

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center gap-3">
                {onBack && (
                    <button
                        onClick={onBack}
                        className="text-sm text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
                    >
                        &larr; Back
                    </button>
                )}
                <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
                    {group.name} — {group.statusCode}
                </h2>
            </div>

            {/* Error Info */}
            <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-4 space-y-3">
                <p className="text-neutral-700 dark:text-neutral-300">{group.message}</p>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                    <div>
                        <span className="text-neutral-500">Method</span>
                        <p className="font-mono">{group.method}</p>
                    </div>
                    <div>
                        <span className="text-neutral-500">Path</span>
                        <p className="font-mono">{group.path}</p>
                    </div>
                    <div>
                        <span className="text-neutral-500">Count</span>
                        <p className="font-mono">{group.count}</p>
                    </div>
                    <div>
                        <span className="text-neutral-500">Status</span>
                        <p className="font-medium">{group.status}</p>
                    </div>
                </div>

                {/* Status Actions */}
                {actions.length > 0 && (
                    <div className="flex gap-2 pt-2">
                        {actions.map((action) => (
                            <button
                                key={action.target}
                                onClick={() => handleStatusChange(action.target)}
                                disabled={isMutating}
                                className="px-3 py-1.5 text-sm rounded border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
                            >
                                {action.label}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            {/* Event Timeline */}
            <div>
                <h3 className="text-sm font-medium text-neutral-500 mb-3">Recent Events</h3>
                <div className="space-y-2">
                    {(events as any[]).map((event: any) => (
                        <div
                            key={event.id}
                            className="rounded border border-neutral-200 dark:border-neutral-800 p-3 text-sm"
                        >
                            <div className="flex justify-between items-start">
                                <div className="space-y-1">
                                    <div className="flex gap-3 text-neutral-500">
                                        <span>User: {event.userId ?? '(anonymous)'}</span>
                                        <span>Request: {event.requestId ?? '(none)'}</span>
                                    </div>
                                    {event.stackTrace && (
                                        <pre className="text-xs text-neutral-600 dark:text-neutral-400 overflow-x-auto whitespace-pre-wrap mt-2 bg-neutral-50 dark:bg-neutral-900 p-2 rounded">
                                            {eventPreview(event.stackTrace)}
                                        </pre>
                                    )}
                                </div>
                                <span className="text-xs text-neutral-400 whitespace-nowrap ml-4">
                                    {new Date(event.createdAt).toLocaleString()}
                                </span>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
