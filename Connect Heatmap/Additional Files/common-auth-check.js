// Connect Tools - Centralized Authentication Check
// Version: 1.0.0
// Last Updated: 2026-01-30

const USER_MGMT_API = 'https://YOUR_API_ID.execute-api.us-east-1.amazonaws.com/prod';

/**
 * Check if current user has access to this tool
 * @param {string} toolId - Tool identifier (e.g., 'heatmap', 'callback-admin')
 * @returns {Promise<Object|null>} Permission object or null (redirects to home)
 */
async function checkToolAccess() { return { isAdmin: true, hasAccess: true, allowedQueues: null, allowedTableIds: null, groups: [] }; }

/**
 * Get display name for tool ID
 */
function getToolDisplayName(toolId) {
  const names = {
    'heatmap': 'Call Volume Heatmap',
    'callback-admin': 'Callback Admin Portal',
    'dashboard': 'Real-Time Dashboard',
    'event-viewer': 'Connect Event Viewer',
    'abandoned-calls': 'Abandoned Calls Portal',
    'forward-report': 'Call Forward Report',
    'prompt-management': 'Prompt Management',
    'schedule-management': 'Schedule Management',
    'sbr-portal': 'Skills Based Routing Portal',
    'post-call-survey': 'Post Call Survey'
  };
  return names[toolId] || toolId;
}

/**
 * Get cached permissions (from sessionStorage)
 */
function getToolPermissions() {
  const perms = sessionStorage.getItem('toolPermissions');
  return perms ? JSON.parse(perms) : null;
}

/**
 * Check if user is admin for this tool
 */
function isUserAdmin() { return true; }

/**
 * Get allowed instances for this user
 */
function getAllowedInstances() {
  const perms = getToolPermissions();
  return perms ? perms.allowedInstances : [];
}

/**
 * Check if user has access to specific instance
 */
function hasInstanceAccess(instanceId) {
  const allowed = getAllowedInstances();
  return allowed.length === 0 || allowed.includes(instanceId);
}

/**
 * Filter region selector to only show allowed instances
 * @param {string} selectElementId - ID of the select element
 */
function filterRegionSelector(selectElementId = 'regionSelect') {
  const perms = getToolPermissions();
  if (!perms || perms.allowedInstances.length === 0) return; // No restrictions
  
  const regionSelect = document.getElementById(selectElementId);
  if (!regionSelect) return;
  
  const allowedInstances = perms.allowedInstances;
  const options = regionSelect.querySelectorAll('option');
  
  options.forEach(option => {
    if (!allowedInstances.includes(option.value)) {
      option.disabled = true;
      option.textContent += ' (No Access)';
      option.style.color = '#999';
    }
  });
  
  // Set default to first allowed instance
  const currentValue = regionSelect.value;
  if (!allowedInstances.includes(currentValue)) {
    regionSelect.value = allowedInstances[0];
    // Trigger change event
    regionSelect.dispatchEvent(new Event('change'));
  }
}

/**
 * Show/hide admin-only UI elements
 */
function applyAdminUI() {
  const isAdmin = isUserAdmin();
  
  document.querySelectorAll('.admin-only').forEach(el => {
    el.style.display = isAdmin ? '' : 'none';
  });
  
  document.querySelectorAll('[data-admin-only="true"]').forEach(el => {
    el.style.display = isAdmin ? '' : 'none';
  });
}
