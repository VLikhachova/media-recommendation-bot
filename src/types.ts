export type Category = string;

export interface CategoryDefinition {
  id: Category;
  label: string;
  isCore: boolean;
  isActive: boolean;
  sortOrder: number;
}

export interface Recommendation {
  title: string;
  category: Category;
  year: number | null;
  note: string | null;
  author?: string | null;
  series?: string | null;
  links?: string[];
}

export interface SourceContext {
  url: string | null;
  text: string;
}
