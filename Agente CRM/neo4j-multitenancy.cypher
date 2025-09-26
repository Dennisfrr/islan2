// Constraints for multi-tenancy
// Ensure leads are unique per organization
CREATE CONSTRAINT lead_id_org_unique IF NOT EXISTS
FOR (l:Lead) REQUIRE (l.idWhatsapp, l.organization_id) IS UNIQUE;

// Optional: follow-up per org uniqueness by elementId is implicit; indexes for filtering
CREATE INDEX followup_org_status_idx IF NOT EXISTS FOR (f:FollowUp) ON (f.organization_id, f.status);

// Optional: message linkage is by relationship; index messages by org if stored
CREATE INDEX message_org_idx IF NOT EXISTS FOR (m:Message) ON (m.organization_id);

// Add organization_id defaults is application responsibility.
