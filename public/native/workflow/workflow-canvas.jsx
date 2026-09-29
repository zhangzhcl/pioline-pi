import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./workflow-canvas.css";
import { BUILTIN_NODE_METAS, nodeMetaKey } from "./builtin-node-registry.js";
import { workflowCanvasInputPorts } from "./workflow-canvas-ports.js";
import {
  workflowCanvasAccessibilityLabels,
  workflowCanvasStatusLabel,
} from "./workflow-canvas-status.js";
import { WorkflowNodeView } from "./workflow-node-view.jsx";

const nodeTypes = { workflow: WorkflowNodeView };

function graphFor(workflow, run, nodeMetas, viewMode, observation, translate) {
  if (viewMode === "pi-subtasks") {
    return {
      nodes: observation.nodes.map((node) => ({
        id: node.id,
        type: "workflow",
        position: node.position,
        data: {
          label: node.label,
          description: node.description,
          inputs: [],
          outputs: [],
          nodeType: node.kind,
          status: node.status,
          statusLabel: workflowCanvasStatusLabel(node.status, translate),
          observed: true,
        },
        deletable: false,
      })),
      edges: observation.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        animated: false,
        selectable: false,
      })),
    };
  }
  return {
    nodes: workflow.nodes.map((instance) => {
      const meta = nodeMetas.get(nodeMetaKey(instance.meta));
      return {
        id: instance.instanceId,
        type: "workflow",
        position: instance.position,
        data: {
          label: meta?.label ?? instance.meta.id,
          inputs: workflowCanvasInputPorts(meta),
          outputs: meta?.outputs ?? [],
          nodeType: meta?.type ?? "custom",
          status: run?.nodeStates?.[instance.instanceId]?.status ?? "idle",
          statusLabel: workflowCanvasStatusLabel(
            run?.nodeStates?.[instance.instanceId]?.status ?? "idle",
            translate,
          ),
        },
        deletable: !["start", "end"].includes(meta?.type),
      };
    }),
    edges: workflow.edges.map((edge) => ({
      id: edge.id,
      source: edge.sourceNodeId,
      target: edge.targetNodeId,
      sourceHandle: `out:${edge.sourcePort}`,
      targetHandle: `in:${edge.targetPort}`,
      animated: false,
    })),
  };
}

function Canvas({
  workflow,
  nodeMetas = BUILTIN_NODE_METAS,
  run,
  viewMode = "workflow",
  observation = { nodes: [], edges: [] },
  translate,
  onMoveNode,
  onConnect,
  onRemoveNode,
  onRemoveEdge,
  onSelectNode,
}) {
  const readOnly = run?.status === "running";
  const initialGraph = graphFor(workflow, run, nodeMetas, viewMode, observation, translate);
  const [nodes, setNodes] = useNodesState(initialGraph.nodes);
  const [edges, setEdges] = useEdgesState(initialGraph.edges);

  useEffect(() => {
    const next = graphFor(workflow, run, nodeMetas, viewMode, observation, translate);
    setNodes(next.nodes);
    setEdges(next.edges);
  }, [workflow, nodeMetas, run, viewMode, observation, translate, setEdges, setNodes]);

  const handleNodesChange = (changes) => {
    for (const change of changes) if (change.type === "remove") onRemoveNode(change.id);
    setNodes((current) =>
      applyNodeChanges(
        changes.filter((change) => change.type !== "remove"),
        current,
      ),
    );
  };
  const handleEdgesChange = (changes) => {
    for (const change of changes) if (change.type === "remove") onRemoveEdge(change.id);
    setEdges((current) =>
      applyEdgeChanges(
        changes.filter((change) => change.type !== "remove"),
        current,
      ),
    );
  };
  const handleConnect = (connection) => {
    const sourcePort = connection.sourceHandle?.replace(/^out:/, "");
    const targetPort = connection.targetHandle?.replace(/^in:/, "");
    if (!connection.source || !connection.target || !sourcePort || !targetPort) return;
    onConnect({
      sourceNodeId: connection.source,
      sourcePort,
      targetNodeId: connection.target,
      targetPort,
    });
    setEdges((current) => addEdge(connection, current));
  };

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      ariaLabelConfig={workflowCanvasAccessibilityLabels(translate)}
      onNodesChange={handleNodesChange}
      onEdgesChange={handleEdgesChange}
      onNodeDragStop={
        viewMode === "workflow" ? (_event, node) => onMoveNode(node.id, node.position) : undefined
      }
      onConnect={handleConnect}
      onNodeClick={(_event, node) => onSelectNode(node.id)}
      nodesDraggable={viewMode === "workflow" && !readOnly}
      nodesConnectable={viewMode === "workflow" && !readOnly}
      elementsSelectable
      deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
      fitView
      proOptions={{ hideAttribution: true }}
    >
      <Background />
      <MiniMap pannable zoomable />
      <Controls aria-label={translate("workflow.canvasA11y.controls")} />
    </ReactFlow>
  );
}

export function mountWorkflowCanvas(container, props) {
  const root = createRoot(container);
  root.render(<Canvas {...props} />);
  return {
    update: (nextProps) => root.render(<Canvas {...nextProps} />),
    unmount: () => root.unmount(),
  };
}
