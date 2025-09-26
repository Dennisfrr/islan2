let current = {
  organization_id: process.env.CRM_ORGANIZATION_ID || null,
  crm_base_url: process.env.CRM_BASE_URL || process.env.CRM_URL || null,
  crm_agent_key: process.env.CRM_AGENT_KEY || process.env.AGENT_API_KEY || null,
  crm_bearer: process.env.CRM_BEARER_TOKEN || process.env.CRM_SERVICE_TOKEN || null
};

function getOrg() { return { ...current }; }
function setOrg(partial) {
  current = { ...current, ...(partial || {}) };
  return getOrg();
}

module.exports = { getOrg, setOrg };


