// Concept-preview data for the four CRM screens (Home, Outreach, Lead, Pipeline).
// Static stand-ins matching the supplied mockups. When a screen is promoted to
// the real product, replace each section here with live API data.
export const previewUser = { name: 'Sarah Chen', firstName: 'Sarah', role: 'Growth · Acme Co', initials: 'SC' }

export const homeStats = [
  { label: 'Total Leads', value: '142', delta: '24%', tint: 'lavender' },
  { label: 'In Pipeline', value: '28', delta: '12%', tint: 'blue' },
  { label: 'Potential Revenue', value: '$486K', delta: '32%', tint: 'green' },
  { label: 'Meetings Booked', value: '12', delta: '50%', tint: 'peach' },
]

export const funnelStages = [
  { label: 'Leads', count: 142, tone: 'violet' },
  { label: 'Contacted', count: 96, tone: 'blue' },
  { label: 'Qualified', count: 48, tone: 'green' },
  { label: 'Proposal', count: 22, tone: 'amber' },
  { label: 'Closed Won', count: 12, tone: 'red' },
]

export function funnelShare(count, total = funnelStages[0].count) {
  return Math.round((count / total) * 100)
}

export const quickActions = [
  { label: 'Add a new lead', icon: 'UserPlus', tint: 'lavender' },
  { label: 'Send an email', icon: 'Mail', tint: 'lavender' },
  { label: 'Create a task', icon: 'CheckSquare', tint: 'blue' },
  { label: 'Book a meeting', icon: 'CalendarPlus', tint: 'blue' },
  { label: 'Import from CSV', icon: 'Upload', tint: 'green' },
]

export const homeActivity = [
  { title: 'Jamie Park viewed your proposal', meta: 'Riverside Health', time: '2h ago', icon: 'Eye', tint: 'lavender', person: 'JP' },
  { title: 'Meeting booked with Alex Kim', meta: 'Summit Technologies', time: '6h ago', icon: 'CalendarCheck', tint: 'blue', person: null },
  { title: 'New lead added from website', meta: 'BrightPath Labs', time: '4h ago', icon: 'FilePlus', tint: 'peach', person: null },
  { title: 'Proposal sent to Taylor Brooks', meta: 'Maple & Co', time: '1d ago', icon: 'FileText', tint: 'green', person: null },
]

export const revenueGoal = { current: '$486K', target: '$600K', percent: 81, dealsAway: 3 }

export const outreachGroups = [
  {
    label: 'Today', count: 3,
    tasks: [
      { title: 'Follow up with Jamie Park', company: 'Riverside Health', priority: 'High', when: '10:00 AM', person: 'JP' },
      { title: 'Send proposal', company: 'Maple & Co', priority: 'Medium', when: '1:00 PM', person: 'AK' },
      { title: 'Prep for discovery call', company: 'Clearview AI', priority: 'Medium', when: '3:00 PM', person: 'TB' },
    ],
  },
  {
    label: 'Tomorrow', count: 2,
    tasks: [
      { title: 'Follow up on pricing questions', company: 'Northpeak', priority: 'Medium', when: '10:00 AM', person: 'AK' },
      { title: 'Send case study', company: 'BrightPath Labs', priority: 'Low', when: '2:00 PM', person: 'JP' },
    ],
  },
  {
    label: 'Later this week', count: 3,
    tasks: [
      { title: 'Check in on trial', company: 'Goodwell', priority: 'Low', when: 'Wed', person: 'AK' },
      { title: 'Follow up (no response)', company: 'Orion Media', priority: 'Medium', when: 'Thu', person: 'JP' },
      { title: 'Schedule next steps', company: 'Fernway', priority: 'Low', when: 'Fri', person: 'TB' },
    ],
  },
]

export const outreachFilters = [
  { label: 'All tasks', active: true },
  { label: 'Due today', badge: '3' },
  { label: 'Overdue', badge: '1' },
  { label: 'This week' },
  { label: 'All owners', menu: true },
]

export const aiSuggestions = [
  { text: "Follow up with 3 leads that haven't replied in 5+ days" },
  { text: 'Send case study to similar companies in your pipeline' },
  { text: 'Book a meeting with high-intent leads (4 recommended)' },
]

export const leadDetail = {
  company: 'Riverside Health',
  badge: 'Hot Lead',
  tagline: 'A modern healthcare provider focused on accessible, high-quality care.',
  tags: ['Healthcare', 'B2B', '500+ employees'],
  location: 'San Francisco, CA',
  website: 'riversidehealth.com',
  summary: "Riverside Health is a fast-growing healthcare provider with 500+ employees, focusing on accessible, patient-first care. They've recently expanded into telehealth and are investing in modern infrastructure, making them a strong fit for Scoutline's outreach and scheduling automation.",
  takeaways: [
    'Growing focus on digital patient experience',
    'Active hiring across multiple regions',
    'Likely to be interested in automation and AI solutions',
  ],
  info: [
    { icon: 'MapPin', label: 'San Francisco, CA' },
    { icon: 'Link', label: 'riversidehealth.com', link: true },
    { icon: 'Users', label: '500 - 1,000 employees' },
    { icon: 'Calendar', label: 'Founded 2018' },
  ],
  opportunities: [
    'Expand into new regions',
    'Growing telehealth services',
    'Interested in AI-powered patient outreach',
    'Potential for multi-year contract',
  ],
  activity: [
    { text: 'Jamie Park sent them an email', time: '2h ago', icon: 'Mail', tint: 'lavender' },
    { text: 'You viewed this lead', time: '5h ago', icon: 'Eye', tint: 'green' },
    { text: 'New lead added from website', time: '1d ago', icon: 'FilePlus', tint: 'peach' },
    { text: 'Meeting booked with Alex Kim', time: '2d ago', icon: 'CalendarCheck', tint: 'blue' },
  ],
}

export const pipelineColumns = [
  {
    stage: 'Leads', count: 42, value: '$1.2M', tone: 'violet',
    deals: [
      { company: 'Riverside Health', tags: ['Healthcare', 'Website'], value: '$80,000', meta: 'Last activity 1h ago', monogram: 'R' },
      { company: 'BrightPath Labs', tags: ['Biotech'], value: '$45,000', meta: '2h ago', monogram: 'B' },
      { company: 'ModernClass', tags: ['EdTech'], value: '$25,000', meta: '4h ago', monogram: 'M' },
    ],
  },
  {
    stage: 'Contacted', count: 28, value: '$780K', tone: 'blue',
    deals: [
      { company: 'Fernway', tags: ['SaaS'], value: '$120,000', meta: '1d ago', monogram: 'F' },
      { company: 'Orion Media', tags: ['Marketing'], value: '$38,000', meta: '2d ago', monogram: 'O' },
      { company: 'Leaf & Stone', tags: ['Home & Garden'], value: '$26,000', meta: '2d ago', monogram: 'L' },
    ],
  },
  {
    stage: 'Qualified', count: 18, value: '$560K', tone: 'green',
    deals: [
      { company: 'Acme Logistics', tags: ['Logistics'], value: '$95,000', meta: '3d ago', monogram: 'A' },
      { company: 'Goodwell', tags: ['Healthcare'], value: '$60,000', meta: '5d ago', monogram: 'G' },
      { company: 'Northpeak', tags: ['Fintech'], value: '$80,000', meta: '3d ago', monogram: 'N' },
    ],
  },
  {
    stage: 'Proposal', count: 10, value: '$320K', tone: 'amber',
    deals: [
      { company: 'Maple & Co', tags: ['Professional Services'], value: '$120,000', meta: '1d ago', monogram: 'M' },
      { company: 'Zenith Tech', tags: ['SaaS'], value: '$85,000', meta: '2d ago', monogram: 'Z' },
      { company: 'Helix Systems', tags: ['IT Services'], value: '$45,000', meta: '4d ago', monogram: 'H' },
    ],
  },
  {
    stage: 'Closed Won', count: 6, value: '$280K', tone: 'red',
    deals: [
      { company: 'TruFit', tags: ['Fitness'], value: 'Won 2d ago', meta: '', monogram: 'T' },
      { company: 'BluePeak', tags: ['Travel'], value: 'Won 1w ago', meta: '', monogram: 'B' },
      { company: 'Solara Health', tags: ['Healthcare'], value: 'Won 2w ago', meta: '', monogram: 'S' },
    ],
  },
]

export const previewScreens = [
  { id: 'home', label: 'Home' },
  { id: 'outreach', label: 'Outreach' },
  { id: 'lead', label: 'Lead detail' },
  { id: 'pipeline', label: 'Pipeline' },
]
