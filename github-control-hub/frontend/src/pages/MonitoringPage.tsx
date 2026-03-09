import { useState } from "react";
import Navbar from "../components/Navbar";
import { useAuth } from "../App";
import { useScanners, useDeleteScanner, useRunScan, useScanResult } from "../hooks/useScanners";
import ScannerModal from "../components/ScannerModal";

export default function MonitoringPage() {
  const { user } = useAuth();
  const { data: scanners, isLoading } = useScanners();
  const deleteMutation = useDeleteScanner();
  const runMutation = useRunScan();

  const [modalOpen, setModalOpen] = useState(false);
  const [editingScanner, setEditingScanner] = useState<any>(null);
  const [expandedResult, setExpandedResult] = useState<string | null>(null);

  const handleEdit = (scanner: any) => {
    setEditingScanner(scanner);
    setModalOpen(true);
  };

  const handleCreate = () => {
    setEditingScanner(null);
    setModalOpen(true);
  };

  const handleDelete = (id: string, name: string) => {
    if (confirm(`Delete scanner "${name}"?`)) {
      deleteMutation.mutate(id);
    }
  };

  const handleRun = (id: string) => {
    runMutation.mutate(id);
    setExpandedResult(id);
  };

  return (
    <div className="bg-gh-light text-gh-text antialiased min-h-screen flex flex-col relative pt-14">
      <Navbar login={user?.login} avatarUrl={user?.avatarUrl} />
      
      <main className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-8 pb-32 animate-fade-in">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
          <div>
            <h1 className="text-2xl font-bold text-gh-textBase tracking-tight">Compliance Monitoring</h1>
            <p className="text-gh-muted text-sm mt-1">Scan your repositories to ensure they meet org-wide branch protection and structural rules.</p>
          </div>
          <button 
            onClick={handleCreate}
            className="inline-flex items-center gap-2 bg-gh-blue hover:bg-gh-blueHover text-white px-4 py-2 rounded-md text-sm font-semibold shadow-sm transition-all focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gh-blue/50"
          >
            <i className="fa-solid fa-plus text-xs"></i>
            New Scanner
          </button>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gh-blue"></div>
          </div>
        ) : (
          <div className="space-y-6">
            {scanners?.map(scanner => (
              <ScannerCard 
                key={scanner.id} 
                scanner={scanner} 
                onEdit={() => handleEdit(scanner)}
                onDelete={() => handleDelete(scanner.id, scanner.name)}
                onRun={() => handleRun(scanner.id)}
                isRunning={runMutation.isPending && runMutation.variables === scanner.id}
                isExpanded={expandedResult === scanner.id}
                toggleExpand={() => setExpandedResult(expandedResult === scanner.id ? null : scanner.id)}
              />
            ))}
            
            {scanners?.length === 0 && (
              <div className="bg-white rounded-lg border border-gh-border p-12 text-center">
                <i className="fa-solid fa-shield-halved text-gray-300 text-4xl mb-4"></i>
                <h3 className="text-lg font-bold text-gh-textBase mb-1">No Scanners Found</h3>
                <p className="text-gh-muted text-sm mb-4">Create a scanner to start monitoring repository compliance.</p>
                <button 
                  onClick={handleCreate}
                  className="bg-gray-100 hover:bg-gray-200 text-gray-800 font-semibold py-1.5 px-4 rounded-md text-sm transition-colors"
                >
                  Create your first scanner
                </button>
              </div>
            )}
          </div>
        )}
      </main>

      {modalOpen && (
        <ScannerModal 
          isOpen={modalOpen} 
          onClose={() => setModalOpen(false)} 
          scanner={editingScanner} 
        />
      )}
    </div>
  );
}

function ScannerCard({ scanner, onEdit, onDelete, onRun, isRunning, isExpanded, toggleExpand }: any) {
  const { data: result, isLoading: resultLoading } = useScanResult(isExpanded ? scanner.id : null);

  const percentage = scanner.lastRunAt && result 
    ? Math.round((result.compliantCount / result.totalScanned) * 100) 
    : null;

  return (
    <div className="bg-white rounded-lg border border-gh-border shadow-sm overflow-hidden">
      <div className="p-5 flex flex-col sm:flex-row justify-between gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-1">
            <h3 className="text-lg font-bold text-gh-textBase">{scanner.name}</h3>
            {percentage !== null && (
              <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${
                percentage === 100 ? 'bg-green-100 text-green-800' : 
                percentage > 70 ? 'bg-yellow-100 text-yellow-800' : 
                'bg-red-100 text-red-800'
              }`}>
                {percentage}% Compliant
              </span>
            )}
          </div>
          <p className="text-sm text-gh-muted">{scanner.description}</p>
          
          <div className="mt-4 flex gap-4 text-xs font-mono text-gh-muted">
            <div className="flex items-center gap-1.5">
              <i className="fa-solid fa-code-branch"></i>
              {scanner.conditions.length} conditions
            </div>
            <div className="flex items-center gap-1.5">
              <i className="fa-regular fa-clock"></i>
              Last run: {scanner.lastRunAt ? new Date(scanner.lastRunAt).toLocaleString() : 'Never'}
            </div>
          </div>
        </div>

        <div className="flex sm:flex-col items-center sm:items-end justify-between gap-2 border-t sm:border-t-0 sm:border-l border-gh-border pt-4 sm:pt-0 sm:pl-5">
          <button
            onClick={onRun}
            disabled={isRunning}
            className="w-full sm:w-auto bg-green-600 hover:bg-green-700 text-white font-semibold py-1.5 px-4 rounded-md text-sm transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {isRunning ? (
              <><i className="fa-solid fa-circle-notch fa-spin"></i> Scanning...</>
            ) : (
              <><i className="fa-solid fa-play"></i> Run Scan</>
            )}
          </button>
          
          <div className="flex items-center gap-1">
            <button onClick={onEdit} className="p-1.5 text-gh-muted hover:text-gh-blue hover:bg-blue-50 rounded transition-colors" title="Edit">
              <i className="fa-solid fa-pen"></i>
            </button>
            <button onClick={onDelete} className="p-1.5 text-gh-muted hover:text-red-600 hover:bg-red-50 rounded transition-colors" title="Delete">
              <i className="fa-regular fa-trash-can"></i>
            </button>
            <button onClick={toggleExpand} className="p-1.5 text-gh-muted hover:text-gray-800 hover:bg-gray-100 rounded transition-colors" title="Toggle Results">
              <i className={`fa-solid fa-chevron-${isExpanded ? 'up' : 'down'}`}></i>
            </button>
          </div>
        </div>
      </div>

      {isExpanded && (
        <div className="border-t border-gh-border bg-gray-50/50 p-5">
          {resultLoading && !result ? (
             <div className="flex justify-center py-6">
               <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-gh-blue"></div>
             </div>
          ) : result ? (
            <div>
              <div className="grid grid-cols-3 gap-4 mb-6">
                <div className="bg-white border border-gray-200 rounded p-3 text-center shadow-sm">
                  <div className="text-2xl font-light text-gray-800">{result.totalScanned}</div>
                  <div className="text-[10px] uppercase font-semibold text-gh-muted tracking-wide mt-1">Repos Scanned</div>
                </div>
                <div className="bg-white border border-green-200 rounded p-3 text-center shadow-sm">
                  <div className="text-2xl font-light text-green-600">{result.compliantCount}</div>
                  <div className="text-[10px] uppercase font-semibold text-green-600/80 tracking-wide mt-1">Compliant</div>
                </div>
                <div className="bg-white border border-red-200 rounded p-3 text-center shadow-sm">
                  <div className="text-2xl font-light text-red-600">{result.nonCompliantCount}</div>
                  <div className="text-[10px] uppercase font-semibold text-red-600/80 tracking-wide mt-1">Non-Compliant</div>
                </div>
              </div>

              <h4 className="text-sm font-bold text-gh-textBase mb-3">Violations</h4>
              {result.violations.length > 0 ? (
                <div className="bg-white border border-gray-200 rounded-md overflow-hidden">
                  <ul className="divide-y divide-gray-100">
                    {result.violations.map((v: any, i: number) => (
                      <li key={i} className="p-3 text-sm flex items-start gap-3">
                        <i className="fa-solid fa-triangle-exclamation text-red-500 mt-0.5"></i>
                        <div>
                          <div className="font-mono text-gh-textBase font-semibold mb-1">
                            {v.repo} <span className="text-gray-400 font-sans mx-1">/</span> {v.branch}
                          </div>
                          <div className="text-gh-muted text-xs">{v.reason}</div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="text-center py-6 text-sm text-green-600 font-medium">
                  <i className="fa-solid fa-party-horn mr-2"></i> All scanned repositories are 100% compliant!
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-6 text-sm text-gh-muted">
              Click "Run Scan" to generate results.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
