/**
 * Strategy registry for canvas-to-video conversion strategies.
 *
 * Each strategy self-registers on import by calling registerStrategy().
 * The registry provides lookup by id and iteration over all strategies.
 *
 * Strategy interface:
 *   { id: string, name: string, description: string, convert: async (batchBuffers, sessionName, opts) => result | null }
 *
 * Result interface:
 *   { videoPath, framesDir, frameCount, videoFrameCount, videoSizeBytes, manifestPath?, manifest? }
 */

const strategies = new Map()

export function registerStrategy(strategy) {
	strategies.set(strategy.id, strategy)
}

export function getStrategy(id) {
	return strategies.get(id) ?? null
}

export function getAllStrategies() {
	return [...strategies.values()]
}

export function getStrategyIds() {
	return [...strategies.keys()]
}
