import {
  applyCommand,
  createNode,
  type CanvasDocument,
  type CanvasNode,
  type CanvasNodeData,
  type CanvasNodeKind,
} from "./model.ts";
import { absolutePosition } from "./geometry.ts";
import { indexNodes, isNodeLocked } from "./hierarchy.ts";
import { sameNodeData } from "./dataBoundary.ts";
import type { CanvasToolTask } from "./toolCatalog.ts";
export interface ResultSource {
  documentId: string;
  nodeId: string;
  kind: CanvasNodeKind;
  src?: string;
  text?: string;
  referenceInputs?: Record<string, string>;
  editorData?: Pick<CanvasNodeData, "timeline" | "localStage">;
}

/** Compositions are backed by an authored document, not necessarily a media URL. */
export function captureEditorSource(
  documentId: string,
  node: CanvasNode,
): ResultSource {
  return {
    documentId,
    nodeId: node.id,
    kind: node.type,
    src: node.data.src,
    ...(node.type === "timeline"
      ? { editorData: structuredClone({ timeline: node.data.timeline }) }
      : node.type === "external"
        ? { editorData: structuredClone({ localStage: node.data.localStage }) }
        : {}),
  };
}
export interface LinkedMediaResult {
  kind: "image" | "video" | "audio";
  src: string;
  mimeType: string;
  title: string;
  media?: CanvasNodeData["media"];
}
export type GenerationResultMode = "replace" | "additional";

type PlacementResult = {
  document: CanvasDocument;
  ids: string[];
  error?: string;
};

function sourceError(document: CanvasDocument, source: ResultSource) {
  if (document.id !== source.documentId) return "项目已切换，结果未写入画布。";
  const target = document.nodes.find((node) => node.id === source.nodeId);
  if (!target) return "来源节点已被删除，结果未写入画布。";
  if (target.type !== source.kind)
    return "来源节点类型已改变，结果未写入画布。";
}

/** Post-edit sessions require the same media or composition and an editable source. */
export function validateNodeActionSource(
  document: CanvasDocument,
  source: Readonly<ResultSource>,
):
  | { node: CanvasNode; error?: undefined }
  | { node?: undefined; error: string } {
  const error = sourceError(document, source);
  if (error) return { error };
  const node = document.nodes.find((item) => item.id === source.nodeId)!;
  const composition =
    source.editorData &&
    ((node.type === "timeline" && source.editorData.timeline) ||
      (node.type === "external" &&
        node.data.external?.externalType === "director-stage"));
  const unchanged = composition
    ? sameNodeData(node.data, { ...node.data, ...source.editorData })
    : !!source.src && node.data.src === source.src;
  if (!unchanged || node.data.assetState === "missing")
    return { error: "来源素材已改变或不可用，请重新打开工具。" };
  if (isNodeLocked(node, indexNodes(document.nodes)))
    return { error: "来源节点已锁定，请先解锁节点。" };
  return { node };
}

function hasInvalidMedia(outputs: readonly LinkedMediaResult[]) {
  return outputs.some(
    (output) =>
      !output.src ||
      !output.mimeType ||
      !["image", "video", "audio"].includes(output.kind),
  );
}

/** Generation fills its existing node. Only explicitly requested extra results add siblings. */
export function applyGenerationResults(
  document: CanvasDocument,
  source: ResultSource,
  outputs: readonly LinkedMediaResult[],
  mode: GenerationResultMode = "replace",
): PlacementResult {
  const error = sourceError(document, source);
  if (error) return { document, ids: [], error };
  const target = document.nodes.find((node) => node.id === source.nodeId)!;
  if (isNodeLocked(target, indexNodes(document.nodes)))
    return {
      document,
      ids: [],
      error: "来源节点已锁定，结果仍保存在生成历史中。",
    };
  if (!outputs.length) return { document, ids: [] };
  if (
    hasInvalidMedia(outputs) ||
    outputs.some((output) => output.kind !== target.type)
  )
    return { document, ids: [], error: "生成结果与节点的媒体类型不匹配。" };
  // Additional results do not mutate their source; a parallel first result may
  // already have filled it. Replacement must never overwrite a user's later edit.
  if (mode === "replace" && target.data.src !== source.src)
    return {
      document,
      ids: [],
      error: "节点素材已改变，结果仍保存在生成历史中。",
    };
  let next = document;
  const ids: string[] = [];
  if (mode === "replace") {
    const first = outputs[0]!;
    next = applyCommand(document, {
      type: "update-node",
      id: target.id,
      patch: {
        data: {
          src: first.src,
          mimeType: first.mimeType,
          assetState: "ready",
          mediaRole: "generation",
          generationEvidence: source.referenceInputs
            ? { output: first.src, references: { ...source.referenceInputs } }
            : undefined,
          ...(first.media ? { media: { ...first.media } } : {}),
        },
      },
    });
    ids.push(target.id);
  }
  const remaining = mode === "replace" ? outputs.slice(1) : outputs;
  if (remaining.length) {
    const p = absolutePosition(target, document.nodes);
    const nodes = placeResults(next, remaining, {
      x: p.x + target.width + 100,
      y: p.y,
    }).map((node) => ({
      ...node,
      data: {
        ...node.data,
        mediaRole: "generation" as const,
        generationEvidence:
          source.referenceInputs && node.data.src
            ? {
                output: node.data.src,
                references: { ...source.referenceInputs },
              }
            : undefined,
        prompt: target.data.prompt,
        ...(target.data.settings
          ? { settings: structuredClone(target.data.settings) }
          : {}),
      },
    }));
    next = { ...next, nodes: [...next.nodes, ...nodes] };
    ids.push(...nodes.map((node) => node.id));
  }
  return { document: next, ids };
}

/** Local imports and pixel operations produce new nodes; their frozen origin must still exist. */
export function appendLinkedMediaResults(
  document: CanvasDocument,
  source: ResultSource,
  outputs: readonly LinkedMediaResult[],
  sourceTask?: CanvasToolTask,
): PlacementResult {
  const validation = validateNodeActionSource(document, source);
  if (!validation.node) return { document, ids: [], error: validation.error };
  const target = validation.node;
  if (!outputs.length) return { document, ids: [] };
  if (hasInvalidMedia(outputs))
    return { document, ids: [], error: "结果不包含有效媒体。" };
  if (sourceTask && sourceTask.sourceNodeIds[0] !== source.nodeId)
    return { document, ids: [], error: "编辑草稿与来源节点不匹配。" };
  const p = absolutePosition(target, document.nodes);
  const nodes = placeResults(document, outputs, {
    x: p.x + target.width + 100,
    y: p.y,
  });
  const edges = nodes.map((node) => ({
    id: crypto.randomUUID(),
    source: target.id,
    target: node.id,
    intent: "post_edit_result" as const,
  }));
  return {
    document: {
      ...document,
      nodes: [
        ...document.nodes.map((node) =>
          sourceTask && node.id === source.nodeId
            ? {
                ...node,
                data: { ...node.data, taskDraft: structuredClone(sourceTask) },
              }
            : node,
        ),
        ...nodes,
      ],
      edges: [...document.edges, ...edges],
    },
    ids: nodes.map((node) => node.id),
  };
}

/**
 * An empty result node linked from the source, placed where its result will
 * land, so a running tool shows its progress on the node it is filling.
 */
export function appendPendingResult(
  document: CanvasDocument,
  source: ResultSource,
  kind: "image" | "video" | "audio",
  title: string,
): PlacementResult {
  const validation = validateNodeActionSource(document, source);
  if (!validation.node) return { document, ids: [], error: validation.error };
  const target = validation.node;
  const p = absolutePosition(target, document.nodes);
  const [placed] = placeResults(
    document,
    [{ kind, src: "", mimeType: "", title }],
    { x: p.x + target.width + 100, y: p.y },
  );
  const node = createNode(kind, placed!.position, { title });
  return {
    document: {
      ...document,
      nodes: [...document.nodes, node],
      edges: [
        ...document.edges,
        {
          id: crypto.randomUUID(),
          source: target.id,
          target: node.id,
          intent: "post_edit_result" as const,
        },
      ],
    },
    ids: [node.id],
  };
}

/** Whether a pending result node is still the untouched placeholder it was created as. */
export function pendingResultNode(document: CanvasDocument, id: string) {
  const node = document.nodes.find((item) => item.id === id);
  return node && !node.data.src && !node.data.text ? node : undefined;
}

/**
 * The first output fills the pending node; further outputs join the source
 * like any linked result. A pending node that was removed, filled by hand or
 * of another media kind leaves every output to the linked placement.
 */
export function fillPendingResult(
  document: CanvasDocument,
  source: ResultSource,
  pendingId: string,
  outputs: readonly LinkedMediaResult[],
  sourceTask?: CanvasToolTask,
): PlacementResult {
  const pending = pendingResultNode(document, pendingId);
  const [first, ...rest] = outputs;
  if (
    !pending ||
    !first ||
    first.kind !== pending.type ||
    hasInvalidMedia(outputs)
  )
    return appendLinkedMediaResults(document, source, outputs, sourceTask);
  const filled = applyCommand(document, {
    type: "update-node",
    id: pending.id,
    patch: {
      data: {
        src: first.src,
        title: first.title,
        mimeType: first.mimeType,
        assetState: "ready",
        mediaRole: "asset",
        ...(first.media ? { media: { ...first.media } } : {}),
      },
    },
  });
  if (rest.length) {
    const linked = appendLinkedMediaResults(filled, source, rest, sourceTask);
    if (linked.error) return linked;
    return { document: linked.document, ids: [pending.id, ...linked.ids] };
  }
  // Like a linked placement, the source keeps the task that produced its result.
  const next = sourceTask
    ? {
        ...filled,
        nodes: filled.nodes.map((node) =>
          node.id === source.nodeId
            ? {
                ...node,
                data: { ...node.data, taskDraft: structuredClone(sourceTask) },
              }
            : node,
        ),
      }
    : filled;
  return { document: next, ids: [pending.id] };
}

/** A failed or cancelled task leaves no empty placeholder behind. */
export function removePendingResult(
  document: CanvasDocument,
  pendingId: string,
): CanvasDocument {
  return pendingResultNode(document, pendingId)
    ? applyCommand(document, { type: "remove-nodes", ids: [pendingId] })
    : document;
}

export type ServiceResult =
  | LinkedMediaResult
  | { kind: "text"; title: string; text: string };

/** Results made outside a canvas source (such as by the assistant) start right of the content. */
export function appendServiceResults(
  document: CanvasDocument,
  outputs: readonly ServiceResult[],
): { document: CanvasDocument; ids: string[] } {
  const placed = document.nodes
    .filter((node) => node.type !== "group")
    .map((node) => ({
      ...absolutePosition(node, document.nodes),
      width: node.width,
    }));
  const nodes = placeResults(
    document,
    outputs,
    placed.length
      ? {
          x: Math.max(...placed.map((rect) => rect.x + rect.width)) + 160,
          y: Math.min(...placed.map((rect) => rect.y)),
        }
      : { x: 0, y: 0 },
  );
  return {
    document: { ...document, nodes: [...document.nodes, ...nodes] },
    ids: nodes.map((node) => node.id),
  };
}

function placeResults(
  document: CanvasDocument,
  outputs: readonly ServiceResult[],
  start: { x: number; y: number },
) {
  const occupied = document.nodes
    .filter((node) => node.type !== "group")
    .map((node) => ({
      ...absolutePosition(node, document.nodes),
      width: node.width,
      height: node.height,
    }));
  return outputs.map((output, index) => {
    const node = createNode(
      output.kind as CanvasNodeKind,
      {
        x: start.x + (index % 4) * 400,
        y: start.y + Math.floor(index / 4) * 400,
      },
      output.kind === "text"
        ? { title: output.title, text: output.text }
        : {
            src: output.src,
            title: output.title,
            mimeType: output.mimeType,
            assetState: "ready",
            mediaRole: "asset",
            ...(output.media ? { media: { ...output.media } } : {}),
          },
    );
    // Repeated operations share an origin, but each result needs its own space.
    // Moving down past a collision cannot collide with that rectangle again.
    for (let attempt = 0; attempt <= occupied.length; attempt++) {
      const collisions = occupied.filter(
        (rect) =>
          node.position.x < rect.x + rect.width + 64 &&
          node.position.x + node.width + 64 > rect.x &&
          node.position.y < rect.y + rect.height + 64 &&
          node.position.y + node.height + 64 > rect.y,
      );
      if (!collisions.length) break;
      node.position.y = Math.max(
        ...collisions.map((rect) => rect.y + rect.height + 64),
      );
    }
    occupied.push({ ...node.position, width: node.width, height: node.height });
    return node;
  });
}
