const asyncTaskQueues = new Map();
const GARBAGE_COLLECTION_LIMIT = 10000;
async function processQueue(taskQueue, cleanupCallback) {
    let offset = 0;
    while (true) {
        let executionLimit = Math.min(taskQueue.length, GARBAGE_COLLECTION_LIMIT);
        for (let i = offset; i < executionLimit; i++) {
            const task = taskQueue[i];
            try {
                task.resolve(await task.awaitable());
            } catch (error) {
                task.reject(error);
            }
        }
        if (executionLimit < taskQueue.length) {
            if (executionLimit >= GARBAGE_COLLECTION_LIMIT) {
                taskQueue.splice(0, executionLimit);
                offset = 0;
            } else {
                offset = executionLimit;
            }
        } else {
            break;
        }
    }
    cleanupCallback();
}

export default function executeTask(bucketKey, asyncFunction) {
    if (!asyncFunction.name) {
        Object.defineProperty(asyncFunction, 'name', {
            writable: true
        });
        if (typeof bucketKey === 'string') {
            asyncFunction.name = bucketKey;
        } else {
            console.warn("Uncontrolled deposit key type (for denomination):", typeof bucketKey, bucketKey);
        }
    }
    let isQueueInactive;
    if (!asyncTaskQueues.has(bucketKey)) {
        asyncTaskQueues.set(bucketKey, []);
        isQueueInactive = true;
    }
    const taskQueue = asyncTaskQueues.get(bucketKey);
    const taskPromise = new Promise((resolve, reject) => taskQueue.push({
        awaitable: asyncFunction,
        resolve,
        reject
    }));
    if (isQueueInactive) {
        processQueue(taskQueue, () => asyncTaskQueues.delete(bucketKey));
    }
    return taskPromise;
}