export type RequestableRoleLike = {
  id: string;
  name: string;
};

export function buildRoleSelectionOptions(roles: RequestableRoleLike[]) {
  return roles.map((role) => ({
    label: role.name.slice(0, 100),
    value: role.id,
    description: role.name.length > 100 ? `${role.name.slice(0, 97)}...` : undefined,
  }));
}

export function formatRequestedRoles(roleNames: string[]): string {
  return roleNames.length ? roleNames.join(", ") : "No roles requested";
}
