export interface CompanyInput { name: string; description: string; website: string; projectIds: string[] }
export interface Company extends CompanyInput { id: string }
export interface ProjectRole { projectId: string; role: string; companyId: string | null }
export interface PersonRelationships { companyId: string | null; assignments: ProjectRole[] }
export interface CompanyPerson { id: string; name: string; projectId: string | null; role: string }
