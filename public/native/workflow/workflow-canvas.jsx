import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import { useCallback, useEffect, useRef, useState } from "react";
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

// ReactFlow renders inside Canvas, so Canvas itself cannot call useReactFlow;
// this bridge hands the viewport-aware coordinate converter up to it.
function FlowPositionBridge({ onReady }) {
  const { screenToFlowPosition } = useReactFlow();
  useEffect(() => {
    onReady(screenToFlowPosition);
  }, [onReady, screenToFlowPosition]);
  return null;
}

const NODE_MENU_WIDTH = 200;
const NODE_MENU_ITEM_HEIGHT = 34;

function CanvasNodeMenu({ clientX, clientY, addableNodes, onPick }) {
  const left = Math.max(8, Math.min(clientX, window.innerWidth - NODE_MENU_WIDTH - 8));
  const height = Math.min(addableNodes.length, 10) * NODE_MENU_ITEM_HEIGHT + 8;
  const top = Math.max(8, Math.min(clientY, window.innerHeight - height - 8));
  return (
    <div className="ui-select-popover workflow-canvas-node-menu" role="menu" style={{ left, top }}>
      {addableNodes.map((node) => (
        <button
          key={node.key}
          type="button"
          role="menuitem"
          className="ui-select-option"
          onClick={() => onPick(node.key)}
        >
          {node.label}
        </button>
      ))}
    </div>
  );
}

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
  addableNodes = [],
  canAddNodes = false,
  onAddNodeAt,
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

  // Right-click on empty canvas opens the add-node menu; the picked node lands
  // at the flow coordinates under the cursor, so zoom/pan stay accounted for.
  const screenToFlowRef = useRef(null);
  const rememberConverter = useCallback((convert) => {
    screenToFlowRef.current = convert;
  }, []);
  const [nodeMenu, setNodeMenu] = useState(null);
  const closeNodeMenu = useCallback(() => setNodeMenu(null), []);
  const handlePaneContextMenu = useCallback(
    (event) => {
      if (!canAddNodes || addableNodes.length === 0) return;
      event.preventDefault();
      const convert = screenToFlowRef.current;
      if (!convert) return;
      setNodeMenu({
        clientX: event.clientX,
        clientY: event.clientY,
        flow: convert({ x: event.clientX, y: event.clientY }),
      });
    },
    [canAddNodes, addableNodes.length],
  );
  const pickNodeFromMenu = (key) => {
    const flow = nodeMenu?.flow;
    setNodeMenu(null);
    if (flow) onAddNodeAt?.(key, flow);
  };

  useEffect(() => {
    if (!nodeMenu) return;
    const onPointerDown = (event) => {
      if (event.target.closest?.(".workflow-canvas-node-menu")) return;
      setNodeMenu(null);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") setNodeMenu(null);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [nodeMenu]);

  return (
    <>
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
        onPaneContextMenu={handlePaneContextMenu}
        onMove={closeNodeMenu}
        nodesDraggable={viewMode === "workflow" && !readOnly}
        nodesConnectable={viewMode === "workflow" && !readOnly}
        elementsSelectable
        deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls aria-label={translate("workflow.canvasA11y.controls")} />
        <FlowPositionBridge onReady={rememberConverter} />
      </ReactFlow>
      {nodeMenu ? (
        <CanvasNodeMenu
          clientX={nodeMenu.clientX}
          clientY={nodeMenu.clientY}
          addableNodes={addableNodes}
          onPick={pickNodeFromMenu}
        />
      ) : null}
    </>
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
