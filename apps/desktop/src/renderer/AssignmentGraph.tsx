import type { Assignment } from '../../../../packages/protocol/src/orchestration';

export function AssignmentGraph({ assignments }: { assignments: Assignment[] }) {
  if (!assignments.length) return <p className="muted">No assignments to map yet.</p>;
  const byId = new Map(assignments.map(item => [item.id, item]));
  const depth = (item: Assignment, seen = new Set<string>()): number => {
    if (seen.has(item.id)) return 0;
    seen.add(item.id);
    return Math.min(3, Math.max(0, ...item.dependsOn.map(id => byId.get(id)).filter((value): value is Assignment => Boolean(value)).map(value => 1 + depth(value, new Set(seen)))));
  };
  const nodes = assignments.map((item, index) => ({ item, index, x: 12 + depth(item) * 156, y: 12 + index * 70 }));
  const positions = new Map(nodes.map(node => [node.item.id, node]));
  return <div className="assignment-map">
    <svg role="img" aria-label="Assignment dependency map; the assignment list below has the full text" viewBox={`0 0 640 ${Math.max(90, nodes.length * 70 + 16)}`}>
      {nodes.flatMap(node => node.item.dependsOn.map(id => {
        const source = positions.get(id);
        return source ? <path key={`${id}-${node.item.id}`} d={`M ${source.x + 136} ${source.y + 23} L ${node.x - 7} ${node.y + 23}`} fill="none" stroke="#8b9d88" strokeWidth="2" /> : null;
      }))}
      {nodes.map(node => <g key={node.item.id} transform={`translate(${node.x} ${node.y})`}>
        <rect width="136" height="48" rx="5" fill={node.item.state === 'integrated' ? '#dcebdc' : node.item.state === 'failed' || node.item.state === 'incomplete' ? '#f4d8cd' : '#f4ead7'} stroke="#8a9d8d" />
        <text x="8" y="19" fontSize="12" fontWeight="bold" fill="#263e34">{node.item.key.slice(0, 17)} · r{node.item.revision}</text>
        <text x="8" y="36" fontSize="11" fill="#455c50">{node.item.state}</text>
      </g>)}
    </svg>
    <p className="muted">Arrows follow recorded assignment dependencies. Use the assignment list for objectives, revisions, evidence and blockers.</p>
  </div>;
}
