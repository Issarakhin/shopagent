import { SkillActionDefinition, SkillDefinition, SkillId } from './types.js';

function action(
  id: string,
  name: string,
  description: string,
  options: Partial<Pick<SkillActionDefinition, 'enabled' | 'riskLevel' | 'writeAction' | 'approvalRequired'>> = {},
): SkillActionDefinition {
  return {
    id,
    name,
    description,
    enabled: options.enabled ?? true,
    riskLevel: options.riskLevel ?? 'low',
    writeAction: options.writeAction ?? false,
    approvalRequired: options.approvalRequired ?? false,
  };
}

function skill(
  id: SkillId,
  name: string,
  description: string,
  actions: SkillActionDefinition[],
): SkillDefinition {
  return {
    id,
    name,
    description,
    enabled: true,
    actions,
    requiresApprovalForWrite: true,
    successCount: 0,
    failureCount: 0,
  };
}

export const DEFAULT_SKILLS: SkillDefinition[] = [
  skill('business-planning', 'Business Planning', 'Plans, prioritizes, summarizes, and coordinates cross-skill business workflows.', [
    action('create_workflow', 'Create workflow', 'Build a dependency-ordered workflow from an admin goal.'),
    action('prioritize_decisions', 'Prioritize decisions', 'Rank approvals and blocked work by risk and impact.'),
    action('generate_daily_summary', 'Generate daily summary', 'Summarize orders, stock, campaigns, and exceptions.'),
    action('generate_weekly_review', 'Generate weekly review', 'Review performance and lessons from the last seven days.'),
  ]),
  skill('marketing', 'Marketing', 'Creates reviewed campaign drafts, prepares Telegram messages, and publishes only after final approval.', [
    action('create_campaign_draft', 'Create campaign draft', 'Prepare a campaign and Telegram content without sending it.', { writeAction: true }),
    action('validate_campaign', 'Validate campaign', 'Check products, stock, budget, segments, and campaign completeness.'),
    action('prepare_telegram_message', 'Prepare Telegram message', 'Draft Khmer and English Telegram content.'),
    action('publish_approved_campaign', 'Publish approved campaign', 'Send an approved campaign to eligible Telegram subscribers.', { riskLevel: 'high', writeAction: true, approvalRequired: true }),
    action('measure_campaign_result', 'Measure campaign result', 'Calculate delivery and response metrics.'),
    action('activate_product_boost', 'Activate product boost', 'Feature an approved product in the storefront.', { riskLevel: 'medium', writeAction: true, approvalRequired: true }),
  ]),
  skill('sales', 'Sales', 'Uses real customer and order data to identify leads, segment customers, and prepare offers.', [
    action('identify_real_leads', 'Identify real leads', 'Find existing customers with genuine purchase or engagement signals.'),
    action('create_offer_draft', 'Create offer draft', 'Prepare an offer without contacting customers.', { writeAction: true }),
    action('update_pipeline', 'Update pipeline', 'Update a lead stage using verified activity.', { riskLevel: 'medium', writeAction: true }),
    action('prepare_follow_up', 'Prepare follow-up', 'Draft a consent-aware follow-up.'),
    action('segment_customers', 'Segment customers', 'Create RFM-style customer segments from real orders.'),
  ]),
  skill('inventory', 'Inventory', 'Checks availability, reserves stock, recommends replenishment, and forecasts demand.', [
    action('check_available_stock', 'Check available stock', 'Return stock availability for selected products.'),
    action('reserve_stock', 'Reserve stock', 'Reserve stock for a verified workflow.', { riskLevel: 'medium', writeAction: true, approvalRequired: true }),
    action('release_stock', 'Release stock', 'Release a previous reservation.', { writeAction: true }),
    action('recommend_reorder', 'Recommend reorder', 'Calculate products that should be reordered.'),
    action('predict_inventory', 'Predict inventory', 'Forecast demand, days of cover, and reorder dates.'),
  ]),
  skill('finance', 'Finance', 'Calculates paid revenue, margin, budgets, dynamic pricing, and revenue opportunities.', [
    action('calculate_paid_revenue', 'Calculate paid revenue', 'Calculate revenue from eligible orders only.'),
    action('calculate_margin', 'Calculate margin', 'Estimate product and order margin.'),
    action('check_campaign_budget', 'Check campaign budget', 'Validate requested campaign spend against limits.'),
    action('reserve_budget', 'Reserve budget', 'Reserve approved campaign budget.', { riskLevel: 'medium', writeAction: true, approvalRequired: true }),
    action('recommend_dynamic_pricing', 'Recommend dynamic pricing', 'Suggest price changes using demand, stock, and margin signals.'),
    action('apply_approved_price', 'Apply approved price', 'Apply an exact approved price recommendation.', { riskLevel: 'high', writeAction: true, approvalRequired: true }),
    action('optimize_revenue', 'Optimize revenue', 'Find revenue improvement opportunities across the ecosystem.'),
  ]),
  skill('support', 'Support', 'Classifies support needs, drafts grounded replies, escalates risk, and proposes refunds.', [
    action('categorize_ticket', 'Categorize ticket', 'Classify a support request.'),
    action('draft_reply', 'Draft reply', 'Draft a grounded response using verified order data.'),
    action('escalate_ticket', 'Escalate ticket', 'Escalate a risky or overdue case.', { riskLevel: 'medium', writeAction: true, approvalRequired: true }),
    action('prepare_refund_request', 'Prepare refund request', 'Prepare a refund request without issuing money.', { riskLevel: 'high', writeAction: true, approvalRequired: true }),
  ]),
  skill('analytics', 'Analytics', 'Produces evidence-based summaries, rankings, anomaly checks, and campaign measurement.', [
    action('generate_sales_summary', 'Generate sales summary', 'Summarize sales and order performance.'),
    action('rank_products', 'Rank products', 'Rank products by smart boost opportunity.'),
    action('detect_anomaly', 'Detect anomaly', 'Detect unusual order, revenue, or stock patterns.'),
    action('measure_campaign_performance', 'Measure campaign performance', 'Evaluate campaign delivery and response.'),
    action('learn_from_outcomes', 'Learn from outcomes', 'Store verified lessons and update recommendation weights.'),
  ]),
  skill('logistics', 'Logistics', 'Validates fulfillment, creates shipment plans, detects delays, and reports exceptions.', [
    action('validate_fulfillment', 'Validate fulfillment', 'Check order, stock, and address readiness.'),
    action('create_shipment', 'Create shipment', 'Create a shipment plan after validation.', { riskLevel: 'medium', writeAction: true, approvalRequired: true }),
    action('check_delivery_delay', 'Check delivery delay', 'Find orders that may be delayed.'),
    action('report_delivery_exception', 'Report delivery exception', 'Create a structured delivery exception.', { writeAction: true }),
  ]),
];
