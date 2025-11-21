
import { useState, useEffect, useRef, useMemo } from 'react';
import { ExperimentScenario, ExperimentResult, NodeStatus, UserAccount, SystemAccount, FilterCondition, SortConfig, Toast, NotificationItem, AllocatorStrategy, TransmitterStrategy, MonitoringUpdate, PacketEvent, MempoolInfo } from './types';
import { VirtualSocket } from './services/mockBackend';
import { api } from './services/api';

// --- 0. useWebSocket ---
export const useWebSocket = <T>(url: string, onMessage?: (data: T) => void) => {
    const [data, setData] = useState<T | null>(null);
    const socketRef = useRef<VirtualSocket | null>(null);
    
    // Use a ref to store the latest onMessage callback.
    // This prevents the socket subscription from being recreated when the callback changes,
    // while ensuring that the latest callback (with fresh closure variables) is always invoked.
    const onMessageRef = useRef(onMessage);
    useEffect(() => {
        onMessageRef.current = onMessage;
    }, [onMessage]);

    useEffect(() => {
        const socket = new VirtualSocket(url);
        socketRef.current = socket;

        socket.onmessage = (event) => {
            const parsed = JSON.parse(event.data);
            setData(parsed);
            if (onMessageRef.current) onMessageRef.current(parsed);
        };

        return () => {
            socket.close();
        };
    }, [url]); 

    return { data, socket: socketRef.current };
};

// --- 1. useResizerPanel ---
export const useResizerPanel = (initialHeight: number = 320, minHeight: number = 100, maxHeightRatio: number = 0.8) => {
    const [isOpen, setIsOpen] = useState(false);
    const [height, setHeight] = useState(initialHeight);
    const panelRef = useRef<HTMLDivElement>(null);
    const resizerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const resizer = resizerRef.current;
        if (!resizer) return;

        const handleMouseDown = (e: MouseEvent) => {
            e.preventDefault();
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
            document.body.style.cursor = 'row-resize';
        };

        const handleMouseMove = (e: MouseEvent) => {
            const newHeight = window.innerHeight - e.clientY;
            if (newHeight > 80 && newHeight < window.innerHeight * maxHeightRatio) {
                setHeight(newHeight);
                if (!isOpen && newHeight > minHeight) setIsOpen(true);
            }
        };

        const handleMouseUp = () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
            document.body.style.cursor = '';
            if (panelRef.current && panelRef.current.clientHeight < 120) setIsOpen(false);
        };

        resizer.addEventListener('mousedown', handleMouseDown);
        return () => { resizer.removeEventListener('mousedown', handleMouseDown); };
    }, [isOpen, minHeight, maxHeightRatio]);

    return { isOpen, setIsOpen, height, panelRef, resizerRef };
};

// --- 2. useScenarioExecution ---
export const useScenarioExecution = (
    notify: (type: 'success' | 'error', title: string, message: string) => void,
    onRegisterResult: (result: ExperimentResult) => void
) => {
    const [scenarios, setScenarios] = useState<ExperimentScenario[]>([]);
    const [isGenerating, setIsGenerating] = useState(false);
    const [isExecutionRunning, setIsExecutionRunning] = useState(false);
    const [executionId, setExecutionId] = useState<string | null>(null);

    // WebSocket for Experiment Progress
    useWebSocket<{ executionId: string, scenarioId?: number, status?: string, log?: string, type?: string }>(
        '/ws/experiment/progress',
        (msg) => {
            if (msg.executionId !== executionId) return;
            
            if (msg.type === 'ALL_COMPLETE') {
                setIsExecutionRunning(false);
                notify('success', 'All Scenarios Processed', 'Batch execution finished.');
                return;
            }

            setScenarios(prev => prev.map(s => {
                if (s.id === msg.scenarioId) {
                    const nextLogs = msg.log ? [...s.logs, msg.log] : s.logs;
                    return {
                        ...s,
                        status: (msg.status as any) || s.status,
                        logs: nextLogs,
                        failReason: msg.status === 'FAIL' ? msg.log : s.failReason
                    };
                }
                return s;
            }));
        }
    );

    const generateScenarios = async (params: any) => {
        setIsGenerating(true);
        await new Promise(r => setTimeout(r, 500)); // Sim generation delay

        const newScenarios: ExperimentScenario[] = [];
        let idCounter = 1;
        const cleanName = params.projectName.replace(/[^a-zA-Z0-9_]/g, '') || 'Exp';

        // Helper to generate range array
        const getRange = (p: any) => {
            if (p.mode === 'fixed') return [p.fixed];
            const res = [];
            const start = Number(p.range.start);
            const end = Number(p.range.end);
            const step = Number(p.range.step);
            
            if (step <= 0 || start > end) return [start]; // Fallback
            for (let i = start; i <= end; i += step) {
                res.push(i);
            }
            return res;
        };

        const dataSizes = getRange(params.dataSizeParams);
        const chunkSizes = getRange(params.chunkSizeParams);
        const allocators = Array.from(params.selectedAllocators as Set<AllocatorStrategy>);
        const transmitters = Array.from(params.selectedTransmitters as Set<TransmitterStrategy>);

        // Cartesian Product Generation
        // DataSize x ChunkSize x Allocators x Transmitters
        for (const ds of dataSizes) {
            for (const cs of chunkSizes) {
                for (const alloc of allocators) {
                    for (const trans of transmitters) {
                        newScenarios.push({
                            id: idCounter++,
                            uniqueId: `${cleanName}_${Date.now()}_${idCounter}`,
                            dataSize: ds,
                            chunkSize: cs,
                            allocator: alloc,
                            transmitter: trans,
                            chains: params.selectedChains.size || 1,
                            targetChains: Array.from(params.selectedChains),
                            budgetLimit: 1000,
                            cost: parseFloat((ds * 0.5 + (alloc === AllocatorStrategy.AVAILABLE ? 5 : 0)).toFixed(2)),
                            status: 'READY',
                            failReason: null,
                            progress: 0,
                            logs: []
                        });
                    }
                }
            }
        }

        setScenarios(newScenarios);
        params.setIsOpen(true);
        setIsGenerating(false);
        notify('success', 'Scenarios Generated', `${newScenarios.length} scenarios created based on parameter ranges.`);
    };

    const executeScenarios = async (projectName: string) => {
        setIsExecutionRunning(true);
        notify('success', 'Job Queued', 'Scenarios sent to execution queue.');
        
        const readyScenarios = scenarios.filter(s => s.status === 'READY');
        const res = await api.experiment.run(readyScenarios);
        setExecutionId(res.executionId);
    };

    const reprocessCondition = (id: number) => {
         setScenarios(prev => prev.map(s => s.id === id ? {...s, status: 'READY', failReason: null} : s));
    };
    
    const handleRecalculateAll = () => {
         setScenarios(prev => prev.map(s => s.status === 'FAIL' ? {...s, status: 'READY', failReason: null} : s));
    };

    return { scenarios, isGenerating, isExecutionRunning, generateScenarios, executeScenarios, reprocessCondition, handleRecalculateAll };
};

// --- 3. useDeploymentControl ---
export const useDeploymentControl = (
    deployedNodeCount: number,
    setDeployedNodeCount: (count: number) => void,
    setIsDockerBuilt: (isBuilt: boolean) => void
) => {
    const [scaleCount, setScaleCount] = useState(deployedNodeCount);
    const [isBuilding, setIsBuilding] = useState(false);
    const [isDeploying, setIsDeploying] = useState(false);
    const [logs, setLogs] = useState<string[]>([]);
    const [activeJobId, setActiveJobId] = useState<string | null>(null);

    // Sync local scale count when prop updates (from monitoring source of truth)
    useEffect(() => { setScaleCount(deployedNodeCount); }, [deployedNodeCount]);

    // Listen for logs
    useWebSocket<{ jobId: string, type: string, message?: string }>('/ws/deployment/logs', (data) => {
        if (data.jobId === activeJobId) {
            if (data.type === 'log' && data.message) {
                setLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${data.message}`]);
            } else if (data.type === 'complete') {
                setIsBuilding(false);
                setIsDockerBuilt(true);
            }
        }
    });

    const handleBuild = async () => {
        if (isBuilding) return;
        setLogs([]);
        setIsBuilding(true);
        const res = await api.deployment.build();
        setActiveJobId(res.jobId);
    };

    const handleDeploy = async () => {
        if (isDeploying) return;
        setLogs(prev => [...prev, '>> Initiating Helm Upgrade...']);
        setIsDeploying(true);
        await api.deployment.scale(scaleCount);
        // Note: In a real app we'd wait for pod ready via WS, here we assume API returns when accepted
        setDeployedNodeCount(scaleCount);
        setLogs(prev => [...prev, '>> Deployment request accepted.']);
        setIsDeploying(false);
    };

    const handleReset = async () => {
        setLogs([]);
        await api.deployment.reset();
        setIsDockerBuilt(false);
        setDeployedNodeCount(0);
    };

    return { scaleCount, setScaleCount, isBuilding, isDeploying, logs, handleBuild, handleDeploy, handleReset };
};

// --- 4. useEconomyManagement ---
export const useEconomyManagement = (
    deployedNodeCount: number,
    addToast: (type: 'success' | 'error', title: string, message: string) => void
) => {
    const [users, setUsers] = useState<UserAccount[]>([]);
    const [systemAccounts, setSystemAccounts] = useState<SystemAccount[]>([]);

    const refresh = async () => {
        const res = await api.economy.getUsers();
        setUsers(res.users);
        setSystemAccounts(res.system);
    };

    useEffect(() => { refresh(); }, [deployedNodeCount]); // Refresh when infra changes (relayers might change)

    const handleCreateUser = async () => {
        await api.economy.createUser();
        refresh();
        addToast('success', 'Created', 'New user account generated.');
    };

    const handleDeleteUser = async (id: string) => {
        await api.economy.deleteUser(id);
        refresh();
        addToast('success', 'Deleted', 'User account removed.');
    };

    const handleFaucet = async (targetId: string) => {
        try {
            const res = await api.economy.faucet(targetId, 1000);
            refresh();
            addToast('success', 'Faucet', `Sent 1000 TKN to ${res.targetName}`);
        } catch (e) {
            addToast('error', 'Failed', 'Faucet transaction failed (Pool empty?)');
        }
    };

    return { users, systemAccounts, handleCreateUser, handleDeleteUser, handleFaucet };
};

// --- 5. useTableFilterSort ---
export const useTableFilterSort = (data: ExperimentResult[], initialSort: SortConfig) => {
    const [searchTerm, setSearchTerm] = useState("");
    const [sortConfig, setSortConfig] = useState<SortConfig>(initialSort);
    const [filters, setFilters] = useState<FilterCondition[]>([]);

    const handleSort = (key: keyof ExperimentResult) => setSortConfig(c => ({ key: key, direction: c.key === key && c.direction === 'desc' ? 'asc' : 'desc' }));
    
    const addFilter = (key: keyof ExperimentResult, value: string, labelPrefix: string) => {
        if (!filters.some(f => f.key === key && f.value === value)) {
            setFilters([...filters, { key: key, value, label: `${labelPrefix}: ${value}` }]);
        }
    };
    
    const removeFilter = (index: number) => setFilters(filters.filter((_, i) => i !== index));

    const processedData = useMemo(() => {
        let processed = [...data];
        if (searchTerm) {
            const lowerTerm = searchTerm.toLowerCase();
            processed = processed.filter(item => Object.values(item as any).some(val => String(val).toLowerCase().includes(lowerTerm)));
        }
        if (filters.length > 0) {
            processed = processed.filter(item => filters.every(cond => String((item as any)[cond.key]) === cond.value));
        }
        processed.sort((a, b) => {
            const av = (a as any)[sortConfig.key];
            const bv = (b as any)[sortConfig.key];
            if (av === undefined || bv === undefined) return 0;
            return av < bv ? (sortConfig.direction === 'asc' ? -1 : 1) : (sortConfig.direction === 'asc' ? 1 : -1);
        });
        return processed;
    }, [data, searchTerm, filters, sortConfig]);

    return { processedData, searchTerm, setSearchTerm, sortConfig, handleSort, filters, addFilter, removeFilter };
};

// --- 6. useNotification ---
export const useNotification = () => {
    const [toasts, setToasts] = useState<Toast[]>([]);
    const [notifications, setNotifications] = useState<NotificationItem[]>([]);
    const [isNotificationOpen, setIsNotificationOpen] = useState(false);
    const notificationRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (notificationRef.current && !notificationRef.current.contains(event.target as Node)) {
                setIsNotificationOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const addToast = (type: 'success' | 'error', title: string, message: string) => {
        const id = Math.random().toString(36).substr(2, 9);
        const newNotification: NotificationItem = { id, type, title, message, timestamp: Date.now(), read: false };

        setNotifications(prev => [newNotification, ...prev]);
        setToasts(prev => {
            const updated = [...prev, { id, type, title, message }];
            if (updated.length > 3) return updated.slice(updated.length - 3);
            return updated;
        });
        setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000);
    };

    const clearNotifications = () => setNotifications([]);

    return { toasts, notifications, isNotificationOpen, setIsNotificationOpen, notificationRef, addToast, clearNotifications };
};

// --- 7. useFileUploadTree ---
export const useFileUploadTree = (notify: (type: 'success' | 'error', title: string, message: string) => void) => {
    const [uploadStats, setUploadStats] = useState<{ count: number, sizeMB: number, tree: any, treeOpen: boolean }>({ count: 0, sizeMB: 0, tree: null, treeOpen: true });
    const fileInputRef = useRef<HTMLInputElement>(null);

    const buildTreeFromProcessedFiles = (files: any[], fileCount: number, totalSize: number) => {
        const root: any = { name: 'root', children: {}, type: 'folder', size: 0 };
        files.forEach(file => {
            const parts = file.path.split('/').filter((p: string) => p.length > 0);
            let current = root;
            parts.forEach((part: string, index: number) => {
                if (index === parts.length - 1) current.children[part] = { name: part, type: 'file', size: file.size };
                else {
                    if (!current.children[part]) current.children[part] = { name: part, children: {}, type: 'folder', size: 0 };
                    current = current.children[part];
                }
            });
        });
        const sizeMB = parseFloat((totalSize / (1024 * 1024)).toFixed(2));
        setUploadStats({ count: fileCount, sizeMB, tree: root, treeOpen: true });
        notify('success', 'Files Parsed', `${fileCount} files processed locally (${sizeMB}MB).`);
        return sizeMB;
    };

    const processFiles = async (fileList: File[]) => {
        const processedFiles: any[] = [];
        let totalSize = 0;
        let fileCount = 0;
        const JSZip = (window as any).JSZip;

        for (const file of fileList) {
            if (file.name.endsWith('.zip') || file.type === 'application/zip' || file.type === 'application/x-zip-compressed') {
                try {
                    const zip = await JSZip.loadAsync(file);
                    // Zip内のファイルを列挙
                    const entries = Object.keys(zip.files).map(name => zip.files[name]);
                    
                    for (const zipEntry of entries) {
                        if (!zipEntry.dir) {
                            // ディレクトリ構造を維持するためのパス
                            const path = zipEntry.name;
                            // ファイル名はパスの末尾
                            const name = path.split('/').pop() || path;
                            
                            // Calculate actual uncompressed size
                            let size = 0;
                            try {
                                const blob = await zipEntry.async("blob");
                                size = blob.size;
                            } catch (e) {
                                console.warn("Failed to read zip entry size", e);
                            }

                            processedFiles.push({ 
                                path: path, 
                                name: name, 
                                size: size 
                            });
                            fileCount++;
                            totalSize += size;
                        }
                    }
                } catch (e) {
                    console.error("Zip error:", e);
                    notify('error', 'Zip Extraction Failed', `Could not extract ${file.name}`);
                }
            } else {
                processedFiles.push({ path: file.webkitRelativePath || file.name, name: file.name, size: file.size });
                totalSize += file.size;
                fileCount++;
            }
        }
        return buildTreeFromProcessedFiles(processedFiles, fileCount, totalSize);
    };

    return { uploadStats, setUploadStats, fileInputRef, processFiles };
};