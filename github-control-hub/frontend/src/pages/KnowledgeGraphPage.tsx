import React, { useState, useCallback, useRef, useEffect } from "react";
import ForceGraph2D from "react-force-graph-2d";
import Navbar from "../components/Navbar";
import { useAuth } from "../App";
import { useGraphNode, useBlastRadius, useUserImpact, useBlastRadiusRanking } from "../hooks/useGraph";
import { useRepos } from "../hooks/useRepos";

export default function KnowledgeGraphPage() {
  const { user } = useAuth();
  const { data: repos } = useRepos();
  
  const [searchQuery, setSearchQuery] = useState("");
  const [activeNode, setActiveNode] = useState<string | null>(null);
  const [analysisType, setAnalysisType] = useState<"none" | "blast-radius" | "user-impact">("none");

  // In a real app we'd fetch the starting root nodes, but for the demo we'll start with a search
  const { data: nodeData, isLoading: nodeLoading } = useGraphNode(activeNode);
  
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (let entry of entries) {
        setDimensions({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery) return;
    
    // Auto format prefixes if missing
    let formattedQuery = searchQuery.trim();
    if (!formattedQuery.includes("#")) {
      if (formattedQuery.includes("-team") || formattedQuery === "engineers") formattedQuery = `TEAM#${formattedQuery}`;
      else if (formattedQuery === "alice" || formattedQuery === "bob") formattedQuery = `USER#${formattedQuery}`;
      else formattedQuery = `REPO#${formattedQuery}`;
    }
    
    // Check if the node is a valid repository when formatted as REPO#
    if (formattedQuery.startsWith("REPO#") && repos) {
      const repoName = formattedQuery.replace("REPO#", "");
      if (!repos.some(r => r.name === repoName)) {
        alert(`Repository "${repoName}" does not exist.`);
        return; // Exit and don't load graph if the repo doesn't exist
      }
    }
    
    setActiveNode(formattedQuery);
    
    if (formattedQuery.startsWith("REPO#")) {
      setAnalysisType("blast-radius");
    } else if (formattedQuery.startsWith("USER#")) {
      setAnalysisType("user-impact");
    } else {
      setAnalysisType("none");
    }
  };

  // Build the graph data for visualization based on the active node
  const graphData = React.useMemo(() => {
    // Prevent rendering a random node if it literally has no edges returned by the API
    if (!activeNode || !nodeData || nodeData.edges.length === 0) return { nodes: [], links: [] };
    
    const nodesMap = new Map();
    const links: any[] = [];
    
    // Add root node
    nodesMap.set(activeNode, { id: activeNode, group: activeNode.split('#')[0] });
    
    // Add edges and target nodes
    nodeData.edges.forEach((edge: any) => {
      // Create a unique ID for the target node
      const targetId = edge.target;
      
      if (!nodesMap.has(targetId)) {
        nodesMap.set(targetId, { id: targetId, group: targetId.split('#')[0] });
      }
      links.push({
        source: activeNode,
        target: targetId,
        label: edge.type,
        metadata: edge.metadata
      });
    });
    
    return {
      nodes: Array.from(nodesMap.values()),
      links
    };
  }, [activeNode, nodeData]);

  const handleNodeClick = useCallback((node: any) => {
    setSearchQuery(node.id);
    setActiveNode(node.id);
    if (node.id.startsWith("REPO#")) setAnalysisType("blast-radius");
    else if (node.id.startsWith("USER#")) setAnalysisType("user-impact");
    else setAnalysisType("none");
  }, []);

  return (
    <div className="bg-gh-bg text-gh-textBase min-h-screen pt-14 flex flex-col">
      <Navbar login={user?.login} avatarUrl={user?.avatarUrl} />
      
      <main className="flex-1 flex overflow-hidden max-w-[1600px] w-full mx-auto p-4 sm:p-6 gap-6">
        
        {/* Left Column: Graph Visualization */}
        <div className="flex-1 flex flex-col bg-white rounded-xl border border-gh-border shadow-sm overflow-hidden">
          <div className="p-4 border-b border-gh-border bg-gray-50 flex items-center justify-between">
            <h2 className="font-bold text-gh-textBase flex items-center gap-2">
              <i className="ph-fill ph-graph text-gh-blue text-lg"></i>
              Knowledge Graph
            </h2>
            
            <form onSubmit={handleSearch} className="flex items-center gap-2 relative">
              <input 
                type="text" 
                list="repo-options"
                placeholder="Search repo, user, team..." 
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-gh-blue"
              />
              <datalist id="repo-options">
                {repos?.map(r => (
                  <option key={r.name} value={r.name} />
                ))}
              </datalist>
              <button type="submit" className="bg-gh-blue text-white px-3 py-1.5 rounded-md text-sm font-medium hover:bg-gh-blueHover transition-colors">
                Search
              </button>
            </form>
          </div>
          
          <div className="flex-1 relative bg-white" ref={containerRef}>
            {activeNode && graphData.nodes.length > 0 ? (
              <ForceGraph2D
                width={dimensions.width}
                height={dimensions.height}
                graphData={graphData}
                nodeLabel="id"
                nodeAutoColorBy="group"
                onNodeClick={handleNodeClick}
                linkColor={() => "#d0d7de"}
                linkWidth={1.5}
                linkDirectionalArrowLength={4}
                linkDirectionalArrowRelPos={1}
                nodeCanvasObject={(node: any, ctx, globalScale) => {
                  const label = node.id.replace(/^(REPO|USER|TEAM|WORKFLOW|DEPENDENCY)#/, '');
                  const fontSize = 14/globalScale;
                  ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif`;
                  
                  const textWidth = ctx.measureText(label).width;
                  const bckgDimensions = [textWidth, fontSize].map(n => n + fontSize * 0.8); // padding
                  
                  // Draw circular background pill
                  ctx.fillStyle = '#f6f8fa';
                  ctx.beginPath();
                  if (typeof ctx.roundRect === 'function') {
                    ctx.roundRect(
                      node.x - bckgDimensions[0] / 2, 
                      node.y - bckgDimensions[1] / 2, 
                      bckgDimensions[0], 
                      bckgDimensions[1],
                      bckgDimensions[1] / 2
                    );
                  } else {
                    // Fallback for older browsers
                    const x = node.x - bckgDimensions[0] / 2;
                    const y = node.y - bckgDimensions[1] / 2;
                    const w = bckgDimensions[0];
                    const h = bckgDimensions[1];
                    const r = bckgDimensions[1] / 2;
                    ctx.moveTo(x + r, y);
                    ctx.lineTo(x + w - r, y);
                    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
                    ctx.lineTo(x + w, y + h - r);
                    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
                    ctx.lineTo(x + r, y + h);
                    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
                    ctx.lineTo(x, y + r);
                    ctx.quadraticCurveTo(x, y, x + r, y);
                  }
                  ctx.fill();
                  
                  // Add subtle border
                  ctx.strokeStyle = '#d0d7de';
                  ctx.lineWidth = 1 / globalScale;
                  ctx.stroke();

                  ctx.textAlign = 'center';
                  ctx.textBaseline = 'middle';
                  
                  // Color text by group
                  if (node.group === "REPO") ctx.fillStyle = "#0969da";
                  else if (node.group === "USER") ctx.fillStyle = "#1a7f37";
                  else if (node.group === "TEAM") ctx.fillStyle = "#8250df";
                  else if (node.group === "WORKFLOW") ctx.fillStyle = "#cf222e";
                  else if (node.group === "DEPENDENCY") ctx.fillStyle = "#9a6700";
                  else ctx.fillStyle = "#24292f";

                  ctx.fillText(label, node.x, node.y);
                  
                  node.__bckgDimensions = bckgDimensions; // to re-use in nodePointerAreaPaint
                }}
                nodePointerAreaPaint={(node: any, color, ctx) => {
                  ctx.fillStyle = color;
                  const bckgDimensions = node.__bckgDimensions;
                  if (bckgDimensions) {
                    const x = node.x - bckgDimensions[0] / 2;
                    const y = node.y - bckgDimensions[1] / 2;
                    const w = bckgDimensions[0];
                    const h = bckgDimensions[1];
                    const r = bckgDimensions[1] / 2;
                    ctx.beginPath();
                    if (typeof ctx.roundRect === 'function') {
                      ctx.roundRect(x, y, w, h, r);
                    } else {
                      ctx.moveTo(x + r, y);
                      ctx.lineTo(x + w - r, y);
                      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
                      ctx.lineTo(x + w, y + h - r);
                      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
                      ctx.lineTo(x + r, y + h);
                      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
                      ctx.lineTo(x, y + r);
                      ctx.quadraticCurveTo(x, y, x + r, y);
                    }
                    ctx.fill();
                  }
                }}
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-gh-muted bg-gray-50">
                {nodeLoading 
                  ? <div className="flex flex-col items-center gap-3">
                      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gh-blue"></div>
                      <p>Loading graph data...</p>
                    </div>
                  : activeNode && nodeData?.edges?.length === 0
                    ? <div className="text-center">
                        <i className="ph-fill ph-warning-circle text-3xl text-gray-400 mb-2 block"></i>
                        <p>No relationships found for <strong>{activeNode.replace(/^(REPO|USER|TEAM|WORKFLOW|DEPENDENCY)#/, '')}</strong>.</p>
                        <p className="text-sm mt-1">It may not exist or has no connected entities.</p>
                      </div>
                    : "Search for a repository, user, or team to explore the graph."}
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Analytics Panel */}
        <div className="w-80 lg:w-96 flex flex-col gap-6">
          {analysisType === "blast-radius" && activeNode && (
            <BlastRadiusPanel 
              repoName={activeNode.replace("REPO#", "")} 
              onClose={() => {
                setActiveNode(null);
                setSearchQuery("");
                setAnalysisType("none");
              }} 
            />
          )}
          
          {analysisType === "user-impact" && activeNode && (
            <UserImpactPanel 
              userName={activeNode.replace("USER#", "")} 
              onClose={() => {
                setActiveNode(null);
                setSearchQuery("");
                setAnalysisType("none");
              }}
            />
          )}
          
          <BlastRadiusRankingPanel onSelectRepo={(repo) => {
            setSearchQuery(`REPO#${repo}`);
            setActiveNode(`REPO#${repo}`);
            setAnalysisType("blast-radius");
          }} collapsed={analysisType !== "none"} />
        </div>

      </main>
    </div>
  );
}

function BlastRadiusPanel({ repoName, onClose }: { repoName: string; onClose: () => void }) {
  const { data, isLoading } = useBlastRadius(repoName);
  
  if (isLoading) return <div className="animate-pulse bg-white rounded-xl border border-gh-border p-6 h-64"></div>;
  if (!data) return null;
  
  return (
    <div className="bg-white rounded-xl border border-gh-border shadow-sm overflow-hidden animate-fade-in flex flex-col max-h-full">
      <div className="bg-red-50 border-b border-red-100 p-4 relative">
        <button 
          onClick={onClose}
          className="absolute top-4 right-4 text-red-400 hover:text-red-700 transition-colors"
        >
          <i className="ph-bold ph-x"></i>
        </button>
        <h3 className="font-bold text-red-800 flex items-center gap-2 pr-6">
          <i className="ph-bold ph-warning-octagon"></i>
          Blast Radius Analysis
        </h3>
        <p className="text-xs text-red-600 mt-1">If <strong>{data.repo}</strong> is compromised, what is affected?</p>
      </div>
      
      <div className="p-4 flex-1 overflow-y-auto space-y-5">
        <div>
          <h4 className="text-xs font-semibold text-gh-muted uppercase tracking-wider mb-2">Downstream Workflows</h4>
          {data.workflows.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {data.workflows.map(wf => (
                <span key={wf} className="text-xs font-mono bg-gray-100 border border-gray-200 px-2 py-1 rounded text-gh-textBase">
                  {wf}
                </span>
              ))}
            </div>
          ) : <span className="text-sm text-gray-400">None</span>}
        </div>
        
        <div>
          <h4 className="text-xs font-semibold text-gh-muted uppercase tracking-wider mb-2">Vulnerable Dependencies</h4>
          {data.vulnerableDependencies.length > 0 ? (
            <ul className="space-y-1">
              {data.vulnerableDependencies.map(dep => (
                <li key={dep.name} className="text-sm flex items-center justify-between">
                  <span className="font-mono">{dep.name}</span>
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border uppercase ${dep.severity === 'critical' ? 'bg-red-100 text-red-800 border-red-200' : 'bg-orange-100 text-orange-800 border-orange-200'}`}>
                    {dep.severity}
                  </span>
                </li>
              ))}
            </ul>
          ) : <span className="text-sm text-gray-400">None</span>}
        </div>
        
        <div>
          <h4 className="text-xs font-semibold text-gh-muted uppercase tracking-wider mb-2">Access Vectors (Teams)</h4>
          {data.teamsWithAccess.length > 0 ? (
            <ul className="space-y-1">
              {data.teamsWithAccess.map(team => (
                <li key={team.name} className="text-sm flex justify-between">
                  <span><i className="ph-fill ph-users text-gray-400 mr-1.5"></i>{team.name}</span>
                  <span className="text-xs text-gray-500 bg-gray-50 px-1.5 rounded">{team.permission}</span>
                </li>
              ))}
            </ul>
          ) : <span className="text-sm text-gray-400">None</span>}
        </div>
      </div>
    </div>
  );
}

function UserImpactPanel({ userName, onClose }: { userName: string; onClose: () => void }) {
  const { data, isLoading } = useUserImpact(userName);
  
  if (isLoading) return <div className="animate-pulse bg-white rounded-xl border border-gh-border p-6 h-64"></div>;
  if (!data) return null;
  
  return (
    <div className="bg-white rounded-xl border border-gh-border shadow-sm overflow-hidden animate-fade-in flex flex-col max-h-full">
      <div className="bg-purple-50 border-b border-purple-100 p-4 relative">
        <button 
          onClick={onClose}
          className="absolute top-4 right-4 text-purple-400 hover:text-purple-700 transition-colors"
        >
          <i className="ph-bold ph-x"></i>
        </button>
        <h3 className="font-bold text-purple-800 flex items-center gap-2 pr-6">
          <i className="ph-bold ph-user-focus"></i>
          User Impact Analysis
        </h3>
        <p className="text-xs text-purple-600 mt-1">If <strong>{data.user}</strong> is compromised, what access do they have?</p>
      </div>
      
      <div className="p-4 grid grid-cols-2 gap-4 border-b border-gray-100">
        <div className="bg-gray-50 rounded p-3 text-center">
          <div className="text-2xl font-light text-gh-textBase">{data.writeOrAdminReposCount}</div>
          <div className="text-[10px] font-semibold text-gh-muted uppercase mt-1">Admin/Write Repos</div>
        </div>
        <div className="bg-red-50 rounded p-3 text-center">
          <div className="text-2xl font-light text-red-600">{data.productionPipelinesReachable}</div>
          <div className="text-[10px] font-semibold text-red-800/70 uppercase mt-1">Reachable Pipelines</div>
        </div>
      </div>
      
      <div className="p-4 flex-1 overflow-y-auto space-y-5">
        <div>
          <h4 className="text-xs font-semibold text-gh-muted uppercase tracking-wider mb-2">Team Memberships</h4>
          <div className="flex flex-wrap gap-2">
            {data.teams.map(t => (
              <span key={t} className="text-xs bg-purple-100 text-purple-800 border border-purple-200 px-2 py-1 rounded-full">
                {t}
              </span>
            ))}
          </div>
        </div>
        
        <div>
          <h4 className="text-xs font-semibold text-gh-muted uppercase tracking-wider mb-2">Effective Repository Access</h4>
          <ul className="space-y-2">
            {data.repos.map(r => (
              <li key={r.repo} className="text-sm bg-gray-50 p-2 rounded border border-gray-200">
                <div className="flex justify-between items-center mb-1">
                  <span className="font-bold text-gh-textBase">{r.repo}</span>
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border uppercase ${['admin', 'write'].includes(r.permission) ? 'bg-red-100 text-red-800 border-red-200' : 'bg-gray-200 text-gray-700 border-gray-300'}`}>
                    {r.permission}
                  </span>
                </div>
                <div className="text-[10px] text-gray-500">
                  {r.access === 'direct' ? 'Direct Access' : `Via Team: ${r.team}`}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function BlastRadiusRankingPanel({ onSelectRepo, collapsed = false }: { onSelectRepo: (repo: string) => void, collapsed?: boolean }) {
  const { data, isLoading } = useBlastRadiusRanking();
  const [showAll, setShowAll] = useState(false);
  
  if (isLoading) return <div className="animate-pulse bg-white rounded-xl border border-gh-border p-6 h-64"></div>;
  
  const hasData = data && data.length > 0;
  
  return (
    <>
      <div className={`bg-white rounded-xl border border-gh-border shadow-sm overflow-hidden animate-fade-in flex flex-col ${collapsed ? 'h-auto max-h-[35vh]' : 'h-[calc(100vh-120px)]'}`}>
        <div className="bg-gray-50 border-b border-gh-border p-4 shrink-0 flex justify-between items-center">
          <div>
            <h3 className="font-bold text-gh-textBase flex items-center gap-2">
              <i className="ph-fill ph-ranking text-gh-blue"></i>
              Top Repos by Blast Radius
            </h3>
            {!collapsed && <p className="text-xs text-gh-muted mt-1">Repositories with the highest potential impact if compromised.</p>}
          </div>
          {collapsed && hasData && (
            <button 
              onClick={() => setShowAll(true)}
              className="text-xs bg-white border border-gray-300 px-2 py-1 rounded text-gray-600 hover:bg-gray-50"
            >
              <i className="ph-bold ph-arrows-out-simple"></i>
            </button>
          )}
        </div>
        
        <div className="p-0 flex-1 overflow-y-auto min-h-0">
          {!hasData ? (
            <div className="p-8 flex flex-col items-center justify-center text-center text-gray-400">
              <i className="ph-light ph-shield-check text-4xl mb-2 text-green-500 opacity-80"></i>
              <p className="font-medium text-gray-500">No vulnerable repos found.</p>
              <p className="text-xs mt-1">Your organization is secure.</p>
            </div>
          ) : (
            <ul className="divide-y divide-gh-border">
              {(data || []).slice(0, collapsed ? 3 : 10).map((item, index) => (
              <li 
                key={item.repo} 
                className={`p-3 hover:bg-gray-50 cursor-pointer transition-colors ${collapsed ? 'py-2' : ''}`}
                onClick={() => onSelectRepo(item.repo)}
              >
                <div className={`flex items-center justify-between ${collapsed ? '' : 'mb-2'}`}>
                  <div className="flex items-center gap-2">
                    <span className={`flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold ${index < 3 ? 'bg-red-100 text-red-700' : 'bg-gray-200 text-gray-600'}`}>
                      {index + 1}
                    </span>
                  <span className="font-bold text-gh-blue text-sm truncate max-w-[140px]" title={item.repo}>{item.repo}</span>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border uppercase whitespace-nowrap
                    ${item.riskLevel === 'CRITICAL' ? 'bg-red-100 text-red-800 border-red-200' : 
                      item.riskLevel === 'HIGH' ? 'bg-orange-100 text-orange-800 border-orange-200' : 
                      item.riskLevel === 'MEDIUM' ? 'bg-yellow-100 text-yellow-800 border-yellow-200' : 
                      'bg-green-100 text-green-800 border-green-200'}`}
                  >
                    {item.riskLevel}
                  </span>
                  {!collapsed && (
                    <span className="text-[10px] text-gray-500 font-mono">
                      {item.score} pts
                    </span>
                  )}
                </div>
                </div>
                
                {!collapsed && (
                  <div className="flex gap-3 text-[10px] text-gray-500 ml-7 mt-2">
                    <span className="flex items-center gap-1" title="Downstream Workflows">
                      <i className="ph-fill ph-git-branch text-gray-400"></i> {item.workflowsCount}
                    </span>
                    <span className="flex items-center gap-1" title="Vulnerable Dependencies">
                      <i className="ph-fill ph-shield-warning text-gray-400"></i> {item.vulnerabilitiesCount}
                    </span>
                    <span className="flex items-center gap-1" title="Access Vectors (Teams/Users)">
                      <i className="ph-fill ph-users text-gray-400"></i> {item.accessVectorsCount}
                    </span>
                  </div>
                )}
              </li>
            ))}
          </ul>
          )}
        </div>
        
        {(!collapsed && hasData && (data || []).length > 10) && (
          <div className="p-3 border-t border-gh-border bg-gray-50 shrink-0">
            <button 
              onClick={() => setShowAll(true)}
              className="w-full py-1.5 text-sm font-medium text-gh-blue hover:text-gh-blueHover bg-white border border-gray-300 rounded hover:bg-gray-50 transition-colors"
            >
              View All Rankings ({(data || []).length})
            </button>
          </div>
        )}
        
        {(collapsed && hasData && (data || []).length > 3) && (
          <div className="p-2 border-t border-gh-border bg-gray-50 shrink-0">
            <button 
              onClick={() => setShowAll(true)}
              className="w-full py-1 text-xs font-medium text-gh-blue hover:text-gh-blueHover"
            >
              View all ({(data || []).length})
            </button>
          </div>
        )}
      </div>

      {showAll && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[85vh] flex flex-col animate-fade-in">
            <div className="p-4 border-b border-gh-border flex justify-between items-center bg-gray-50 rounded-t-xl">
              <h2 className="font-bold text-lg text-gh-textBase flex items-center gap-2">
                <i className="ph-fill ph-ranking text-gh-blue"></i>
                Repository Risk Ranking
              </h2>
              <button onClick={() => setShowAll(false)} className="text-gray-400 hover:text-gray-700">
                <i className="ph-bold ph-x text-xl"></i>
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-4">
              <div className="border border-gh-border rounded-md overflow-hidden">
                <table className="w-full text-sm text-left">
                  <thead className="text-xs text-gh-muted bg-gray-50 uppercase border-b border-gh-border">
                    <tr>
                      <th className="px-4 py-3">Rank</th>
                      <th className="px-4 py-3">Repository</th>
                      <th className="px-4 py-3 text-center" title="Downstream Workflows">Workflows</th>
                      <th className="px-4 py-3 text-center" title="Vulnerable Dependencies">Vulns</th>
                      <th className="px-4 py-3 text-center" title="Access Vectors">Access</th>
                      <th className="px-4 py-3 text-right">Risk Score</th>
                      <th className="px-4 py-3 text-right">Level</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gh-border bg-white">
                    {(data || []).map((item, index) => (
                      <tr 
                        key={item.repo} 
                        className="hover:bg-gray-50 cursor-pointer"
                        onClick={() => {
                          onSelectRepo(item.repo);
                          setShowAll(false);
                        }}
                      >
                        <td className="px-4 py-3">
                          <span className={`flex items-center justify-center w-6 h-6 rounded-full text-[11px] font-bold ${index < 3 ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'}`}>
                            {index + 1}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-medium text-gh-blue">{item.repo}</td>
                        <td className="px-4 py-3 text-center text-gray-600">{item.workflowsCount}</td>
                        <td className="px-4 py-3 text-center text-gray-600">
                          {item.vulnerabilitiesCount > 0 
                            ? <span className="text-red-600 font-medium">{item.vulnerabilitiesCount}</span>
                            : <span>0</span>
                          }
                        </td>
                        <td className="px-4 py-3 text-center text-gray-600">{item.accessVectorsCount}</td>
                        <td className="px-4 py-3 text-right font-mono text-gray-600">{item.score} pts</td>
                        <td className="px-4 py-3 text-right">
                          <span className={`text-[10px] font-bold px-2 py-1 rounded border uppercase whitespace-nowrap
                            ${item.riskLevel === 'CRITICAL' ? 'bg-red-100 text-red-800 border-red-200' : 
                              item.riskLevel === 'HIGH' ? 'bg-orange-100 text-orange-800 border-orange-200' : 
                              item.riskLevel === 'MEDIUM' ? 'bg-yellow-100 text-yellow-800 border-yellow-200' : 
                              'bg-green-100 text-green-800 border-green-200'}`}
                          >
                            {item.riskLevel}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}