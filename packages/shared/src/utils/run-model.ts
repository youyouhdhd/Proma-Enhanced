import type { Channel, RunModelSnapshot } from '../types'

function normalizeModelId(modelId: string | undefined): string | undefined {
  const normalized = modelId?.trim().replace(/\[1m\]$/i, '').toLowerCase()
  return normalized || undefined
}

export function createRunModelSnapshot(input: {
  channel: Pick<Channel, 'id' | 'name' | 'models'>
  requestedModelId?: string
  executedModelId: string
  capturedAt?: string
}): RunModelSnapshot {
  const executedModelId = input.executedModelId.trim().replace(/\[1m\]$/i, '')
  const requestedModelId = input.requestedModelId?.trim() || undefined
  const configuredModel = input.channel.models.find(
    (model) => normalizeModelId(model.id) === normalizeModelId(executedModelId),
  )
  const fallbackUsed = !!requestedModelId
    && normalizeModelId(requestedModelId) !== normalizeModelId(executedModelId)

  return {
    requested: {
      channelId: input.channel.id,
      ...(requestedModelId ? { modelId: requestedModelId } : {}),
    },
    executed: {
      channelId: input.channel.id,
      channelName: input.channel.name,
      modelId: executedModelId,
      ...(configuredModel?.name ? { modelName: configuredModel.name } : {}),
    },
    fallback: {
      used: fallbackUsed,
      ...(fallbackUsed ? { fromModelId: requestedModelId } : {}),
    },
    capturedAt: input.capturedAt ?? new Date().toISOString(),
  }
}

/** 最终展示只读取 executed；没有执行事实时不从 requested 猜测。 */
export function formatExecutedModelDisplay(runModel: RunModelSnapshot | undefined): string | undefined {
  const executed = runModel?.executed
  if (!executed) return undefined
  const model = executed.modelName || executed.modelId
  const channel = executed.channelName || executed.channelId
  return channel ? `${channel} / ${model}` : model
}

export function getExecutedModelId(runModel: RunModelSnapshot | undefined): string | undefined {
  return runModel?.executed?.modelId
}
