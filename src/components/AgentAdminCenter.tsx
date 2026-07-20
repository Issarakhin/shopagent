import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bot,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  CircleOff,
  Clock3,
  Database,
  Gauge,
  HeartPulse,
  History,
  Loader2,
  Megaphone,
  MemoryStick,
  Pause,
  Play,
  RefreshCw,
  Rocket,
  Save,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Store,
  ToggleLeft,
  ToggleRight,
  Users,
  WalletCards,
  Workflow,
  X,
} from 'lucide-react';
import { agentApi } from '../agent-api';
import type { AgentState, ApprovalRequest, Campaign, SkillDefinition, Workflow as WorkflowType } from '../agent-types';
import type { Product } from '../types';

interface Props {
  products: Product[];
  onShowNotification: (message: string, type: 'success' | 'error' | 'warning') => void;
}

type Tab = 'main' | 'skills' | 'workflows' | 'approvals' | 'campaigns' | 'system' | 'phase2' | 'history';

const tabItems: Array<{ id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'main', label: 'Main Agent', icon: Bot },
  { id: 'skills', label: 'Skill Store', icon: Sparkles },
  { id: 'workflows', label: 'Workflows', icon: Workflow },
  { id: 'approvals', label: 'Approvals', icon: ShieldCheck },
  { id: 'campaigns', label: 'Campaigns', icon: Megaphone },
  { id: 'system', label: 'Brain & Heartbeat', icon: HeartPulse },
  { id: 'phase2', label: 'Phase 2 Intelligence', icon: Rocket },
  { id: 'history', label: 'History & Audit', icon: History },
];

const statusClass: Record<string, string> = {
  pending: 'bg-slate-100 text-slate-700',
  waiting_approval: 'bg-amber-100 text-amber-800',
  approved: 'bg-blue-100 text-blue-800',
  running: 'bg-indigo-100 text-indigo-800',
  publishing: 'bg-indigo-100 text-indigo-800',
  completed: 'bg-emerald-100 text-emerald-800',
  published: 'bg-emerald-100 text-emerald-800',
  partially_published: 'bg-orange-100 text-orange-800',
  failed: 'bg-red-100 text-red-800',
  blocked: 'bg-red-100 text-red-800',
  rejected: 'bg-red-100 text-red-800',
  cancelled: 'bg-gray-100 text-gray-700',
  paused: 'bg-gray-100 text-gray-700',
  active: 'bg-emerald-100 text-emerald-800',
  recommended: 'bg-purple-100 text-purple-800',
  pending_approval: 'bg-amber-100 text-amber-800',
};

function Badge({ status }: { status: string }) {
  return <span className={`inline-flex rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-wide ${statusClass[status] ?? 'bg-gray-100 text-gray-700'}`}>{status.replaceAll('_', ' ')}</span>;
}

function Toggle({ enabled, onClick, label }: { enabled: boolean; onClick: () => void; label?: string }) {
  return (
    <button onClick={onClick} className="inline-flex items-center gap-2 text-xs font-semibold text-gray-600 hover:text-gray-900">
      {enabled ? <ToggleRight className="h-7 w-7 text-emerald-600" /> : <ToggleLeft className="h-7 w-7 text-gray-400" />}
      {label && <span>{label}</span>}
    </button>
  );
}

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-gray-100 bg-white p-5 shadow-3xs ${className}`}>{children}</div>;
}

function formatTime(value?: string) {
  if (!value) return 'Never';
  return new Date(value).toLocaleString();
}

export default function AgentAdminCenter({ products, onShowNotification }: Props) {
  const [state, setState] = useState<AgentState | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('main');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [command, setCommand] = useState('Create a Telegram campaign for low-selling products with healthy stock.');
  const [lastPlan, setLastPlan] = useState<any>(null);
  const [expandedWorkflow, setExpandedWorkflow] = useState<string | null>(null);
  const [editingCampaign, setEditingCampaign] = useState<Campaign | null>(null);
  const [subscriber, setSubscriber] = useState({ chatId: '', displayName: '', marketingConsent: false, language: 'both' });

  const refresh = async () => {
    setLoading(true);
    try {
      setState(await agentApi.state());
    } catch (error) {
      onShowNotification(error instanceof Error ? error.message : 'Could not load agent system.', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const doAction = async (key: string, action: () => Promise<unknown>, successMessage: string) => {
    setBusy(key);
    try {
      const result = await action();
      onShowNotification(successMessage, 'success');
      await refresh();
      return result;
    } catch (error) {
      onShowNotification(error instanceof Error ? error.message : 'Action failed.', 'error');
      return undefined;
    } finally {
      setBusy(null);
    }
  };

  const submitCommand = async () => {
    if (!command.trim()) return;
    setBusy('plan');
    try {
      const result = await agentApi.plan(command.trim());
      setLastPlan(result);
      onShowNotification('Main Agent created and started the workflow.', 'success');
      await refresh();
      if (result?.workflow?.id) setExpandedWorkflow(result.workflow.id);
    } catch (error) {
      onShowNotification(error instanceof Error ? error.message : 'Planning failed.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const pendingApprovals = state?.approvals.filter((item) => item.status === 'pending') ?? [];
  const activeWorkflows = state?.workflows.filter((item) => !['completed', 'failed', 'cancelled'].includes(item.status)) ?? [];
  const recentFailures = state?.executions.filter((item) => item.status === 'failed').slice(0, 5) ?? [];
  const productMap = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);

  if (loading && !state) {
    return <div className="flex min-h-72 items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-emerald-600" /></div>;
  }
  if (!state) return null;

  return (
    <div className="space-y-6">
      <div className="rounded-3xl bg-gradient-to-br from-gray-950 via-emerald-950 to-teal-900 p-6 text-white shadow-lg sm:p-8">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-emerald-300/20 bg-emerald-300/10 px-3 py-1 text-xs font-semibold text-emerald-200">
              <BrainCircuit className="h-4 w-4" /> Shopping Cambodia Business Intelligence
            </div>
            <h3 className="text-2xl font-bold tracking-tight sm:text-3xl">One Main Agent. Controlled Skills. Verified Actions.</h3>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-emerald-100/80">The Main Agent plans work. Skills perform narrow capabilities. High-risk actions wait for approval, and Telegram can send only the approved campaign version.</p>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:min-w-[440px]">
            {[
              ['Skills enabled', state.skills.filter((item) => item.enabled).length, Sparkles],
              ['Active workflows', activeWorkflows.length, Workflow],
              ['Pending approvals', pendingApprovals.length, ShieldCheck],
              ['Memories', state.memories.length, MemoryStick],
            ].map(([label, value, Icon]: any) => (
              <div key={label} className="rounded-2xl border border-white/10 bg-white/10 p-3 backdrop-blur-sm">
                <Icon className="mb-2 h-4 w-4 text-emerald-300" />
                <div className="text-xl font-bold">{value}</div>
                <div className="text-[10px] uppercase tracking-wide text-emerald-100/70">{label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="flex gap-2 overflow-x-auto rounded-2xl border border-gray-100 bg-white p-2 shadow-3xs">
        {tabItems.map((tab) => {
          const Icon = tab.icon;
          return (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)} className={`flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold transition ${activeTab === tab.id ? 'bg-emerald-600 text-white shadow-sm' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900'}`}>
              <Icon className="h-4 w-4" /> {tab.label}
              {tab.id === 'approvals' && pendingApprovals.length > 0 && <span className="rounded-full bg-amber-400 px-1.5 py-0.5 text-[9px] text-gray-950">{pendingApprovals.length}</span>}
            </button>
          );
        })}
      </div>

      {activeTab === 'main' && (
        <div className="grid gap-6 xl:grid-cols-[1.35fr_0.65fr]">
          <Card>
            <div className="mb-4 flex items-center justify-between">
              <div><h4 className="font-bold text-gray-900">Main Business Agent</h4><p className="text-xs text-gray-500">Ask for a business outcome. The brain creates a controlled workflow.</p></div>
              <Badge status={state.controls.brainEnabled ? 'active' : 'paused'} />
            </div>
            <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
              <textarea value={command} onChange={(event) => setCommand(event.target.value)} rows={4} className="w-full resize-none rounded-xl border border-gray-200 bg-white p-3 text-sm outline-none focus:ring-2 focus:ring-emerald-500/20" placeholder="Tell the Main Agent what the business should achieve..." />
              <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-wrap gap-2">
                  {['Prepare a daily business summary', 'Predict products that need restocking', 'Find revenue optimization opportunities'].map((item) => <button key={item} onClick={() => setCommand(item)} className="rounded-full border border-gray-200 bg-white px-3 py-1.5 text-[11px] text-gray-600 hover:border-emerald-300 hover:text-emerald-700">{item}</button>)}
                </div>
                <button onClick={submitCommand} disabled={busy === 'plan' || !state.controls.brainEnabled} className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50">
                  {busy === 'plan' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Create Workflow
                </button>
              </div>
            </div>
            {lastPlan && (
              <div className="mt-4 rounded-2xl border border-emerald-100 bg-emerald-50 p-4">
                <div className="flex items-start gap-3"><Sparkles className="mt-0.5 h-5 w-5 text-emerald-600" /><div><p className="text-sm font-bold text-emerald-900">{lastPlan.plan?.summary}</p><p className="mt-1 text-xs text-emerald-700">Planner source: {lastPlan.source}. Workflow: {lastPlan.workflow?.name}</p></div></div>
              </div>
            )}
            <div className="mt-6 space-y-3">
              <h5 className="text-xs font-bold uppercase tracking-wider text-gray-400">Active workflow progress</h5>
              {activeWorkflows.length === 0 ? <Empty text="No workflow is active." /> : activeWorkflows.slice(0, 4).map((workflow) => <WorkflowCard key={workflow.id} workflow={workflow} expanded={expandedWorkflow === workflow.id} onToggle={() => setExpandedWorkflow(expandedWorkflow === workflow.id ? null : workflow.id)} />)}
            </div>
          </Card>

          <div className="space-y-6">
            <Card>
              <h4 className="mb-4 flex items-center gap-2 font-bold text-gray-900"><ShieldCheck className="h-5 w-5 text-amber-600" /> Approval attention</h4>
              {pendingApprovals.length === 0 ? <Empty text="No actions are waiting for approval." /> : pendingApprovals.slice(0, 4).map((approval) => <div key={approval.id} className="mb-3 rounded-xl border border-amber-100 bg-amber-50 p-3"><p className="text-xs font-bold text-amber-900">{approval.summary}</p><p className="mt-1 text-[11px] text-amber-700">{approval.expectedEffect}</p><button onClick={() => setActiveTab('approvals')} className="mt-2 text-[11px] font-bold text-amber-800 underline">Review approval</button></div>)}
            </Card>
            <Card>
              <h4 className="mb-4 flex items-center gap-2 font-bold text-gray-900"><AlertTriangle className="h-5 w-5 text-red-500" /> Recent failures</h4>
              {recentFailures.length === 0 ? <Empty text="No recent execution failures." /> : recentFailures.map((item: any) => <div key={item.id} className="mb-3 rounded-xl bg-red-50 p-3 text-xs"><p className="font-bold text-red-800">{item.skill}: {item.action}</p><p className="mt-1 text-red-600">{item.error?.message}</p></div>)}
            </Card>
          </div>
        </div>
      )}

      {activeTab === 'skills' && (
        <div className="grid gap-5 lg:grid-cols-2">
          {state.skills.map((skill) => <SkillCard key={skill.id} skill={skill} busy={busy} onToggleSkill={(enabled) => doAction(`skill-${skill.id}`, () => agentApi.toggleSkill(skill.id, enabled), `${skill.name} ${enabled ? 'enabled' : 'disabled'}.`)} onToggleAction={(actionId, enabled) => doAction(`action-${skill.id}-${actionId}`, () => agentApi.toggleAction(skill.id, actionId, enabled), `${actionId} ${enabled ? 'enabled' : 'disabled'}.`)} />)}
        </div>
      )}

      {activeTab === 'workflows' && (
        <div className="space-y-4">
          {state.workflows.length === 0 ? <Card><Empty text="No workflows have been created." /></Card> : state.workflows.map((workflow) => <WorkflowCard key={workflow.id} workflow={workflow} expanded={expandedWorkflow === workflow.id} onToggle={() => setExpandedWorkflow(expandedWorkflow === workflow.id ? null : workflow.id)} />)}
        </div>
      )}

      {activeTab === 'approvals' && (
        <div className="space-y-4">
          {state.approvals.length === 0 ? <Card><Empty text="No approval requests exist." /></Card> : state.approvals.map((approval) => <ApprovalCard key={approval.id} approval={approval} busy={busy} onDecision={(decision) => doAction(`approval-${approval.id}`, () => agentApi.decideApproval(approval.id, decision), `Approval ${decision.replace('_', ' ')}.`)} />)}
        </div>
      )}

      {activeTab === 'campaigns' && (
        <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
          <div className="space-y-4">
            {state.campaigns.length === 0 ? <Card><Empty text="Create a campaign through the Main Agent." /></Card> : state.campaigns.map((campaign) => (
              <Card key={campaign.id}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><div className="flex items-center gap-2"><h4 className="font-bold text-gray-900">{campaign.name}</h4><Badge status={campaign.status} /></div><p className="mt-1 text-xs text-gray-500">Version {campaign.version} · {campaign.productIds.length} products · estimated {campaign.estimatedRecipientCount} eligible recipients</p></div><button onClick={() => setEditingCampaign({ ...campaign })} className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-600 hover:bg-gray-50">Review / Edit</button></div>
                <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">{[['Sent', campaign.sentCount], ['Failed', campaign.failedCount], ['Skipped', campaign.skippedCount], ['Duplicates blocked', campaign.duplicatePreventedCount]].map(([label, value]) => <div key={label} className="rounded-xl bg-gray-50 p-3"><div className="text-lg font-bold text-gray-900">{value}</div><div className="text-[10px] uppercase tracking-wide text-gray-400">{label}</div></div>)}</div>
                <div className="mt-4 rounded-xl bg-gray-50 p-3"><p className="text-[10px] font-bold uppercase text-gray-400">English Telegram message</p><p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-gray-700">{campaign.telegramMessageEn}</p></div>
              </Card>
            ))}
          </div>
          <div className="space-y-6">
            <Card>
              <h4 className="font-bold text-gray-900">Telegram subscriber</h4><p className="mt-1 text-xs text-gray-500">Add a real chat only after the user gives marketing consent.</p>
              <div className="mt-4 space-y-3"><input value={subscriber.chatId} onChange={(e) => setSubscriber({ ...subscriber, chatId: e.target.value })} placeholder="Telegram chat ID" className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm" /><input value={subscriber.displayName} onChange={(e) => setSubscriber({ ...subscriber, displayName: e.target.value })} placeholder="Display name" className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm" /><select value={subscriber.language} onChange={(e) => setSubscriber({ ...subscriber, language: e.target.value })} className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm"><option value="both">Khmer + English</option><option value="km">Khmer</option><option value="en">English</option></select><label className="flex items-center gap-2 text-xs text-gray-600"><input type="checkbox" checked={subscriber.marketingConsent} onChange={(e) => setSubscriber({ ...subscriber, marketingConsent: e.target.checked })} /> Marketing consent confirmed</label><button onClick={() => doAction('subscriber', () => agentApi.addSubscriber({ ...subscriber, segmentIds: ['all-consented'] }), 'Telegram subscriber saved.')} disabled={!subscriber.chatId || !subscriber.marketingConsent} className="w-full rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40">Save subscriber</button></div>
              <p className="mt-3 text-[11px] text-gray-400">Stored subscribers: {state.telegramSubscribers.length}. A publish still needs final campaign approval and live Telegram environment variables.</p>
            </Card>
          </div>
        </div>
      )}

      {editingCampaign && (
        <CampaignEditor campaign={editingCampaign} onClose={() => setEditingCampaign(null)} onChange={setEditingCampaign} onSave={async () => { await doAction(`campaign-${editingCampaign.id}`, () => agentApi.updateCampaign(editingCampaign.id, { name: editingCampaign.name, telegramMessageKh: editingCampaign.telegramMessageKh, telegramMessageEn: editingCampaign.telegramMessageEn, segmentIds: editingCampaign.segmentIds, budget: editingCampaign.budget }), 'Campaign saved as a new review version.'); setEditingCampaign(null); }} />
      )}

      {activeTab === 'system' && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <h4 className="mb-4 flex items-center gap-2 font-bold text-gray-900"><BrainCircuit className="h-5 w-5 text-purple-600" /> Brain and ecosystem controls</h4>
            <div className="space-y-3">
              {(Object.entries(state.controls) as Array<[string, boolean]>).map(([key, enabled]) => <div key={key} className="flex items-center justify-between rounded-xl border border-gray-100 p-3"><div><p className="text-sm font-semibold text-gray-800">{key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}</p><p className="text-[11px] text-gray-400">Runtime-enforced server control</p></div><Toggle enabled={enabled} onClick={() => doAction(`control-${key}`, () => agentApi.updateControls({ [key]: !enabled }), `${key} updated.`)} /></div>)}
            </div>
          </Card>
          <Card>
            <div className="flex items-start justify-between"><div><h4 className="flex items-center gap-2 font-bold text-gray-900"><HeartPulse className="h-5 w-5 text-red-500" /> Server heartbeat</h4><p className="mt-1 text-xs text-gray-500">Checks the ecosystem without sending repetitive Telegram alerts.</p></div><Toggle enabled={state.heartbeat.enabled} onClick={() => doAction('heartbeat-toggle', () => agentApi.updateHeartbeat({ enabled: !state.heartbeat.enabled }), 'Heartbeat setting updated.')} /></div>
            <div className="mt-5 grid grid-cols-2 gap-3"><Metric label="Interval" value={`${state.heartbeat.intervalMinutes} min`} /><Metric label="Last run" value={state.heartbeat.lastRunAt ? new Date(state.heartbeat.lastRunAt).toLocaleTimeString() : 'Never'} /></div>
            <div className="mt-4 space-y-2">{(Object.entries(state.heartbeat.checks) as Array<[string, boolean]>).map(([key, value]) => <div key={key} className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2 text-xs"><span>{key.replace(/([A-Z])/g, ' $1')}</span><span className={value ? 'text-emerald-600' : 'text-gray-400'}>{value ? 'Enabled' : 'Disabled'}</span></div>)}</div>
            <button onClick={() => doAction('heartbeat', agentApi.runHeartbeat, 'Heartbeat completed.')} className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-red-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-400">{busy === 'heartbeat' ? <Loader2 className="h-4 w-4 animate-spin" /> : <HeartPulse className="h-4 w-4" />} Run heartbeat now</button>
          </Card>
          <Card>
            <h4 className="mb-3 flex items-center gap-2 font-bold text-gray-900"><MemoryStick className="h-5 w-5 text-blue-600" /> Long-term memory</h4>
            {state.memories.length === 0 ? <Empty text="Memory will fill with verified outcomes and heartbeat observations." /> : state.memories.slice(0, 8).map((memory: any) => <div key={memory.id} className="mb-3 rounded-xl border border-gray-100 p-3"><div className="flex items-center justify-between"><p className="text-xs font-bold text-gray-800">{memory.topic}</p><span className="text-[10px] text-gray-400">{Math.round(memory.confidence * 100)}% confidence</span></div><p className="mt-1 text-xs leading-5 text-gray-600">{memory.content}</p></div>)}
          </Card>
          <Card>
            <h4 className="mb-3 flex items-center gap-2 font-bold text-gray-900"><Database className="h-5 w-5 text-teal-600" /> Cache</h4><p className="text-sm text-gray-600">{state.cache.length} active entries reduce repeated OpenAI calls and repeated calculations.</p><div className="mt-4 rounded-xl bg-teal-50 p-4 text-xs leading-5 text-teal-800">Cached plans expire automatically. Business mutations are never served from cache.</div>
          </Card>
        </div>
      )}

      {activeTab === 'phase2' && (
        <div className="space-y-6">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Phase2Action icon={Gauge} title="Dynamic pricing" description="Recommend prices using stock, demand, and conversion signals. Applying a price requires approval." onRun={() => doAction('pricing', agentApi.pricing, 'Pricing recommendations refreshed.')} busy={busy === 'pricing'} />
            <Phase2Action icon={Users} title="Customer segmentation" description="Build VIP, recent, new, and at-risk segments from real orders." onRun={() => doAction('segments', agentApi.segments, 'Customer segments refreshed.')} busy={busy === 'segments'} />
            <Phase2Action icon={BarChart3} title="Predictive inventory" description="Forecast daily demand, days of cover, and suggested reorder quantity." onRun={() => doAction('forecast', agentApi.inventoryForecast, 'Inventory forecasts refreshed.')} busy={busy === 'forecast'} />
            <Phase2Action icon={WalletCards} title="Revenue optimization" description="Combine pricing, boosts, and stock risk into prioritized opportunities." onRun={() => doAction('revenue', agentApi.revenueOpportunities, 'Revenue opportunities refreshed.')} busy={busy === 'revenue'} />
          </div>

          <Card>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h4 className="flex items-center gap-2 font-bold text-gray-900"><Store className="h-5 w-5 text-emerald-600" /> Smart product boost</h4><p className="text-xs text-gray-500">Boost score combines stock, recent sales, views, cart activity, and conversion.</p></div><button onClick={() => doAction('boosts', agentApi.recalcBoosts, 'Smart boost scores refreshed.')} className="inline-flex items-center justify-center gap-2 rounded-xl border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50">{busy === 'boosts' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Recalculate</button></div>
            <div className="mt-5 grid gap-4 lg:grid-cols-2">{state.boosts.slice(0, 8).map((boost) => <div key={boost.id} className="rounded-2xl border border-gray-100 p-4"><div className="flex items-start justify-between"><div><p className="font-bold text-gray-900">{productMap.get(boost.productId)?.name ?? boost.productId}</p><p className="mt-1 text-xs text-gray-500">{boost.reason}</p></div><div className="text-right"><div className="text-2xl font-black text-emerald-600">{boost.score}</div><Badge status={boost.status} /></div></div><div className="mt-4 h-2 overflow-hidden rounded-full bg-gray-100"><div className="h-full rounded-full bg-emerald-500" style={{ width: `${boost.score}%` }} /></div><div className="mt-3 flex gap-2">{boost.status === 'recommended' && <button onClick={() => doAction(`boost-${boost.id}`, () => agentApi.requestBoostApproval(boost.id), 'Boost approval requested.')} className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white">Request approval</button>}{boost.status === 'active' && <button onClick={() => doAction(`pause-${boost.id}`, () => agentApi.pauseBoost(boost.id), 'Boost paused.')} className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-700"><Pause className="mr-1 inline h-3 w-3" />Pause</button>}</div></div>)}</div>
          </Card>

          <div className="grid gap-6 xl:grid-cols-2">
            <DataList title="Dynamic pricing recommendations" items={state.pricingRecommendations.slice(0, 8)} render={(item: any) => <><p className="font-semibold text-gray-800">{productMap.get(item.productId)?.name ?? item.productId}</p><p className="text-xs text-gray-500">${item.currentPrice} → ${item.recommendedPrice} ({item.changePercent}%) · {item.reason}</p></>} />
            <DataList title="Revenue opportunities" items={state.revenueOpportunities} render={(item: any) => <><p className="font-semibold text-gray-800">{item.title}</p><p className="text-xs text-gray-500">{item.description}</p><p className="mt-1 text-[11px] font-semibold text-emerald-600">Estimated impact ${item.estimatedMonthlyImpact}/month · {Math.round(item.confidence * 100)}% confidence</p></>} />
            <DataList title="Customer segments" items={state.customerSegments} render={(item: any) => <><p className="font-semibold text-gray-800">{item.name} <span className="text-gray-400">({item.customerEmails?.length ?? 0})</span></p><p className="text-xs text-gray-500">{item.description} · {item.ruleSummary}</p></>} />
            <DataList title="Predictive inventory" items={state.inventoryForecasts.slice(0, 8)} render={(item: any) => <><p className="font-semibold text-gray-800">{productMap.get(item.productId)?.name ?? item.productId}</p><p className="text-xs text-gray-500">Demand {item.dailyDemand}/day · cover {item.daysOfCover ?? '∞'} days · reorder {item.recommendedReorderQuantity}</p></>} />
          </div>
        </div>
      )}

      {activeTab === 'history' && (
        <div className="grid gap-6 xl:grid-cols-2">
          <Card><h4 className="mb-4 flex items-center gap-2 font-bold text-gray-900"><Activity className="h-5 w-5 text-indigo-600" /> Execution history</h4>{state.executions.length === 0 ? <Empty text="No skill execution history." /> : state.executions.slice(0, 30).map((item: any) => <div key={item.id} className="mb-3 rounded-xl border border-gray-100 p-3"><div className="flex items-center justify-between"><p className="text-xs font-bold text-gray-800">{item.skill}: {item.action}</p><Badge status={item.status} /></div><p className="mt-1 text-[11px] text-gray-400">Attempt {item.attempt} · {formatTime(item.startedAt)}</p>{item.error && <p className="mt-1 text-xs text-red-600">{item.error.message}</p>}</div>)}</Card>
          <Card><h4 className="mb-4 flex items-center gap-2 font-bold text-gray-900"><History className="h-5 w-5 text-teal-600" /> Audit log</h4>{state.auditLogs.length === 0 ? <Empty text="No audit records." /> : state.auditLogs.slice(0, 40).map((item: any) => <div key={item.id} className="mb-3 rounded-xl border border-gray-100 p-3"><div className="flex items-center justify-between"><p className="text-xs font-bold text-gray-800">{item.action}</p><span className={item.success ? 'text-emerald-600' : 'text-red-600'}>{item.success ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}</span></div><p className="mt-1 text-[11px] text-gray-400">{item.actor} · {formatTime(item.timestamp)}</p><p className="mt-1 text-xs text-gray-600">{item.resultSummary}</p></div>)}</Card>
        </div>
      )}
    </div>
  );
}

function SkillCard({ skill, busy, onToggleSkill, onToggleAction }: { skill: SkillDefinition; busy: string | null; onToggleSkill: (enabled: boolean) => void; onToggleAction: (actionId: string, enabled: boolean) => void }) {
  const total = skill.successCount + skill.failureCount;
  const successRate = total ? Math.round((skill.successCount / total) * 100) : 0;
  return <Card><div className="flex items-start justify-between gap-4"><div><div className="flex items-center gap-2"><h4 className="font-bold text-gray-900">{skill.name}</h4><Badge status={skill.enabled ? 'active' : 'paused'} /></div><p className="mt-1 text-xs leading-5 text-gray-500">{skill.description}</p></div><Toggle enabled={skill.enabled} onClick={() => onToggleSkill(!skill.enabled)} /></div><div className="mt-4 grid grid-cols-3 gap-2"><Metric label="Success" value={`${successRate}%`} /><Metric label="Executions" value={String(total)} /><Metric label="Last run" value={skill.lastExecutionAt ? new Date(skill.lastExecutionAt).toLocaleDateString() : 'Never'} /></div><div className="mt-4 space-y-2">{skill.actions.map((action) => <div key={action.id} className={`flex items-start justify-between gap-3 rounded-xl border p-3 ${action.enabled && skill.enabled ? 'border-gray-100 bg-gray-50/70' : 'border-gray-100 bg-gray-50 opacity-60'}`}><div><div className="flex flex-wrap items-center gap-2"><p className="text-xs font-bold text-gray-800">{action.name}</p><span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${action.riskLevel === 'high' ? 'bg-red-100 text-red-700' : action.riskLevel === 'medium' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'}`}>{action.riskLevel}</span>{action.approvalRequired && <span className="rounded bg-purple-100 px-1.5 py-0.5 text-[9px] font-bold uppercase text-purple-700">approval</span>}</div><p className="mt-1 text-[11px] text-gray-500">{action.description}</p></div><Toggle enabled={action.enabled} onClick={() => onToggleAction(action.id, !action.enabled)} /></div>)}</div>{busy === `skill-${skill.id}` && <Loader2 className="mt-3 h-4 w-4 animate-spin text-emerald-600" />}</Card>;
}

function WorkflowCard({ workflow, expanded, onToggle }: { workflow: WorkflowType; expanded: boolean; onToggle: () => void }) {
  return <Card><button onClick={onToggle} className="flex w-full items-start justify-between gap-4 text-left"><div className="flex gap-3">{expanded ? <ChevronDown className="mt-0.5 h-4 w-4 text-gray-400" /> : <ChevronRight className="mt-0.5 h-4 w-4 text-gray-400" />}<div><div className="flex flex-wrap items-center gap-2"><h4 className="font-bold text-gray-900">{workflow.name}</h4><Badge status={workflow.status} /><span className="text-[10px] font-bold uppercase text-gray-400">{workflow.riskLevel} risk</span></div><p className="mt-1 text-xs text-gray-500">{workflow.goal}</p></div></div><span className="text-sm font-bold text-emerald-600">{workflow.progress}%</span></button><div className="mt-4 h-2 overflow-hidden rounded-full bg-gray-100"><div className="h-full bg-emerald-500 transition-all" style={{ width: `${workflow.progress}%` }} /></div>{expanded && <div className="mt-4 space-y-3">{workflow.steps.map((step, index) => <div key={step.id} className="flex gap-3 rounded-xl border border-gray-100 bg-gray-50 p-3"><div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white text-xs font-bold text-gray-500 shadow-sm">{index + 1}</div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><p className="text-xs font-bold text-gray-800">{step.skill}: {step.action}</p><Badge status={step.status} /></div><p className="mt-1 text-[11px] text-gray-400">Depends on: {step.dependsOn.length ? step.dependsOn.join(', ') : 'none'} · attempts {step.attempt}</p>{step.error && <p className="mt-1 text-xs text-red-600">{step.error.message}</p>}</div></div>)}</div>}</Card>;
}

function ApprovalCard({ approval, busy, onDecision }: { approval: ApprovalRequest; busy: string | null; onDecision: (decision: 'approved' | 'rejected' | 'changes_requested') => void }) {
  return <Card><div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between"><div className="max-w-3xl"><div className="flex flex-wrap items-center gap-2"><h4 className="font-bold text-gray-900">{approval.summary}</h4><Badge status={approval.status} /><span className="rounded bg-red-100 px-2 py-1 text-[10px] font-bold uppercase text-red-700">{approval.riskLevel} risk</span></div><p className="mt-2 text-sm text-gray-600">{approval.expectedEffect}</p><div className="mt-3 flex flex-wrap gap-3 text-[11px] text-gray-500"><span>Skill: {approval.skill}</span><span>Action: {approval.action}</span>{approval.estimatedCost !== undefined && <span>Cost: ${approval.estimatedCost}</span>}{approval.recipientCount !== undefined && <span>Recipients: {approval.recipientCount}</span>}<span>Rollback: {approval.rollbackPossible ? 'possible' : 'not guaranteed'}</span></div><p className="mt-2 text-[11px] text-gray-400">Requested {formatTime(approval.requestedAt)} · expires {formatTime(approval.expiresAt)}</p></div>{approval.status === 'pending' && <div className="flex flex-wrap gap-2"><button onClick={() => onDecision('approved')} disabled={busy === `approval-${approval.id}`} className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white"><Check className="h-3.5 w-3.5" />Approve</button><button onClick={() => onDecision('changes_requested')} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">Request changes</button><button onClick={() => onDecision('rejected')} className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700"><X className="h-3.5 w-3.5" />Reject</button></div>}</div></Card>;
}

function CampaignEditor({ campaign, onChange, onSave, onClose }: { campaign: Campaign; onChange: (campaign: Campaign) => void; onSave: () => void; onClose: () => void }) {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/60 p-4 backdrop-blur-sm"><div className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-3xl bg-white p-6 shadow-2xl"><div className="flex items-start justify-between"><div><h3 className="text-xl font-bold text-gray-900">Campaign review</h3><p className="text-xs text-gray-500">Editing creates a new version and invalidates any previous approval.</p></div><button onClick={onClose} className="rounded-full bg-gray-100 p-2"><X className="h-4 w-4" /></button></div><div className="mt-5 space-y-4"><label className="block text-xs font-bold text-gray-600">Name<input value={campaign.name} onChange={(e) => onChange({ ...campaign, name: e.target.value })} className="mt-1 w-full rounded-xl border border-gray-200 p-3 text-sm" /></label><label className="block text-xs font-bold text-gray-600">Khmer Telegram message<textarea rows={5} value={campaign.telegramMessageKh} onChange={(e) => onChange({ ...campaign, telegramMessageKh: e.target.value })} className="mt-1 w-full rounded-xl border border-gray-200 p-3 text-sm" /></label><label className="block text-xs font-bold text-gray-600">English Telegram message<textarea rows={5} value={campaign.telegramMessageEn} onChange={(e) => onChange({ ...campaign, telegramMessageEn: e.target.value })} className="mt-1 w-full rounded-xl border border-gray-200 p-3 text-sm" /></label><label className="block text-xs font-bold text-gray-600">Budget (USD)<input type="number" value={campaign.budget} onChange={(e) => onChange({ ...campaign, budget: Number(e.target.value) })} className="mt-1 w-full rounded-xl border border-gray-200 p-3 text-sm" /></label></div><div className="mt-6 flex justify-end gap-3"><button onClick={onClose} className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm font-semibold text-gray-600">Cancel</button><button onClick={onSave} className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white"><Save className="h-4 w-4" />Save review version</button></div></div></div>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="rounded-xl bg-gray-50 p-3"><div className="text-sm font-bold text-gray-900">{value}</div><div className="mt-1 text-[9px] font-bold uppercase tracking-wide text-gray-400">{label}</div></div>; }
function Empty({ text }: { text: string }) { return <div className="rounded-xl border border-dashed border-gray-200 p-6 text-center text-xs text-gray-400">{text}</div>; }
function Phase2Action({ icon: Icon, title, description, onRun, busy }: { icon: React.ComponentType<{ className?: string }>; title: string; description: string; onRun: () => void; busy: boolean }) { return <Card><Icon className="h-6 w-6 text-emerald-600" /><h4 className="mt-3 font-bold text-gray-900">{title}</h4><p className="mt-1 min-h-14 text-xs leading-5 text-gray-500">{description}</p><button onClick={onRun} className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gray-900 px-3 py-2.5 text-xs font-semibold text-white">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}Run analysis</button></Card>; }
function DataList({ title, items, render }: { title: string; items: any[]; render: (item: any) => React.ReactNode }) { return <Card><h4 className="mb-4 font-bold text-gray-900">{title}</h4>{items.length === 0 ? <Empty text="Run the analysis to generate results." /> : items.map((item, index) => <div key={item.id ?? index} className="mb-3 rounded-xl border border-gray-100 p-3">{render(item)}</div>)}</Card>; }
