export type SkillId =
  | 'business-planning'
  | 'marketing'
  | 'sales'
  | 'inventory'
  | 'finance'
  | 'support'
  | 'analytics'
  | 'logistics';

export type RiskLevel = 'low' | 'medium' | 'high' | 'prohibited';
export type WorkflowStatus = 'pending' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'blocked' | 'cancelled';
export type StepStatus = 'pending' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'blocked' | 'cancelled';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'changes_requested' | 'expired';
export type CampaignStatus =
  | 'draft'
  | 'awaiting_review'
  | 'approved'
  | 'publishing'
  | 'published'
  | 'partially_published'
  | 'failed'
  | 'rejected'
  | 'cancelled'
  | 'paused';

export interface SkillActionDefinition {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  riskLevel: RiskLevel;
  writeAction: boolean;
  approvalRequired: boolean;
}

export interface SkillDefinition {
  id: SkillId;
  name: string;
  description: string;
  enabled: boolean;
  actions: SkillActionDefinition[];
  requiresApprovalForWrite: boolean;
  lastExecutionAt?: string;
  successCount: number;
  failureCount: number;
}

export interface SkillError {
  code: string;
  message: string;
}

export interface ProposedAction {
  skill: SkillId;
  action: string;
  summary: string;
  riskLevel: RiskLevel;
  input: Record<string, unknown>;
}

export interface SkillResult {
  success: boolean;
  skill: SkillId;
  action: string;
  summary: string;
  data?: Record<string, unknown>;
  warnings?: string[];
  requiresApproval: boolean;
  proposedActions?: ProposedAction[];
  error?: SkillError;
}

export interface WorkflowStep {
  id: string;
  workflowId: string;
  skill: SkillId;
  action: string;
  dependsOn: string[];
  requiresApproval: boolean;
  status: StepStatus;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  attempt: number;
  idempotencyKey: string;
  error?: SkillError;
  startedAt?: string;
  completedAt?: string;
  approvalId?: string;
}

export interface Workflow {
  id: string;
  name: string;
  goal: string;
  status: WorkflowStatus;
  progress: number;
  riskLevel: Exclude<RiskLevel, 'prohibited'>;
  createdBy: string;
  createdAt: string;
  completedAt?: string;
  relatedRecords: string[];
  steps: WorkflowStep[];
}

export interface ApprovalRequest {
  id: string;
  workflowId: string;
  stepId: string;
  skill: SkillId;
  action: string;
  riskLevel: 'medium' | 'high';
  status: ApprovalStatus;
  summary: string;
  expectedEffect: string;
  estimatedCost?: number;
  recipientCount?: number;
  dataAffected: string[];
  rollbackPossible: boolean;
  requestedAt: string;
  expiresAt: string;
  decidedAt?: string;
  decidedBy?: string;
  decisionNote?: string;
  resourceId?: string;
  resourceVersion?: number;
}

export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  version: number;
  productIds: string[];
  segmentIds: string[];
  telegramMessageKh: string;
  telegramMessageEn: string;
  estimatedRecipientCount: number;
  budget: number;
  scheduledAt?: string;
  approvalId?: string;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  workflowId?: string;
  sentCount: number;
  failedCount: number;
  skippedCount: number;
  duplicatePreventedCount: number;
}

export type CampaignRecipientStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'skipped'
  | 'unsubscribed'
  | 'duplicate_prevented';

export interface CampaignRecipient {
  id: string;
  campaignId: string;
  telegramChatId: string;
  status: CampaignRecipientStatus;
  telegramMessageId?: string;
  retryCount: number;
  idempotencyKey: string;
  sentAt?: string;
  error?: string;
}

export interface TelegramSubscriber {
  id: string;
  chatId: string;
  displayName: string;
  isActive: boolean;
  isSubscribed: boolean;
  marketingConsent: boolean;
  segmentIds: string[];
  language: 'km' | 'en' | 'both';
  unsubscribedAt?: string;
  lastMarketingMessageAt?: string;
  createdAt: string;
}

export interface SkillExecution {
  id: string;
  workflowId: string;
  stepId: string;
  skill: SkillId;
  action: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  status: 'pending' | 'running' | 'completed' | 'failed';
  attempt: number;
  idempotencyKey: string;
  startedAt?: string;
  completedAt?: string;
  error?: SkillError;
}

export interface AuditLog {
  id: string;
  actor: string;
  actorRole: string;
  action: string;
  skill?: SkillId;
  workflowId?: string;
  businessRecordId?: string;
  inputSummary?: string;
  resultSummary?: string;
  previousState?: unknown;
  newState?: unknown;
  approvalId?: string;
  riskLevel?: RiskLevel;
  timestamp: string;
  success: boolean;
  error?: SkillError;
}

export interface AgentMemory {
  id: string;
  type: 'learning' | 'preference' | 'outcome' | 'observation';
  topic: string;
  content: string;
  confidence: number;
  source: string;
  createdAt: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

export interface CacheEntry {
  key: string;
  value: unknown;
  createdAt: string;
  expiresAt: string;
}

export interface HeartbeatConfig {
  enabled: boolean;
  intervalMinutes: number;
  lastRunAt?: string;
  nextRunAt?: string;
  running: boolean;
  checks: {
    lowStock: boolean;
    staleApprovals: boolean;
    campaignPerformance: boolean;
    productBoosts: boolean;
    predictiveInventory: boolean;
  };
}

export interface AgentControls {
  brainEnabled: boolean;
  automationPaused: boolean;
  learningEnabled: boolean;
  dynamicPricingEnabled: boolean;
  segmentationEnabled: boolean;
  revenueOptimizationEnabled: boolean;
  predictiveInventoryEnabled: boolean;
}

export interface StoreEvent {
  id: string;
  type: 'product_view' | 'add_to_cart' | 'purchase' | 'search' | 'checkout_started';
  productId?: string;
  userId?: string;
  sessionId?: string;
  quantity?: number;
  value?: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface ProductBoost {
  id: string;
  productId: string;
  score: number;
  reason: string;
  status: 'recommended' | 'pending_approval' | 'active' | 'paused' | 'rejected';
  createdAt: string;
  updatedAt: string;
  approvalId?: string;
  expiresAt?: string;
}

export interface DynamicPricingRecommendation {
  id: string;
  productId: string;
  currentPrice: number;
  recommendedPrice: number;
  changePercent: number;
  reason: string;
  confidence: number;
  status: 'recommended' | 'pending_approval' | 'approved' | 'applied' | 'rejected';
  createdAt: string;
  approvalId?: string;
}

export interface CustomerSegment {
  id: string;
  name: string;
  description: string;
  customerEmails: string[];
  ruleSummary: string;
  generatedAt: string;
}

export interface InventoryForecast {
  id: string;
  productId: string;
  dailyDemand: number;
  daysOfCover: number | null;
  reorderDate?: string;
  recommendedReorderQuantity: number;
  confidence: number;
  generatedAt: string;
}

export interface RevenueOpportunity {
  id: string;
  title: string;
  description: string;
  estimatedMonthlyImpact: number;
  confidence: number;
  recommendedSkill: SkillId;
  recommendedAction: string;
  createdAt: string;
}

export interface MainAgentPlanStep {
  id: string;
  skill: SkillId;
  action: string;
  dependsOn: string[];
  requiresApproval: boolean;
  input: Record<string, unknown>;
}

export interface MainAgentPlan {
  intent: string;
  summary: string;
  requiresWorkflow: boolean;
  warnings: string[];
  workflow?: {
    name: string;
    goal: string;
    riskLevel: 'low' | 'medium' | 'high';
    steps: MainAgentPlanStep[];
  };
  clarificationQuestion?: string;
}

export interface AgentState {
  version: number;
  controls: AgentControls;
  skills: SkillDefinition[];
  workflows: Workflow[];
  approvals: ApprovalRequest[];
  campaigns: Campaign[];
  campaignRecipients: CampaignRecipient[];
  telegramSubscribers: TelegramSubscriber[];
  executions: SkillExecution[];
  auditLogs: AuditLog[];
  memories: AgentMemory[];
  cache: CacheEntry[];
  heartbeat: HeartbeatConfig;
  events: StoreEvent[];
  boosts: ProductBoost[];
  pricingRecommendations: DynamicPricingRecommendation[];
  customerSegments: CustomerSegment[];
  inventoryForecasts: InventoryForecast[];
  revenueOpportunities: RevenueOpportunity[];
}
