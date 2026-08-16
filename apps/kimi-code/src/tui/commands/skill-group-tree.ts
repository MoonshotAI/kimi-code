import type { SkillSummary } from '@moonshot-ai/kimi-code-sdk';
import path from 'pathe';

export interface SkillGroupNode {
  readonly path: string;
  readonly label: string;
  readonly childGroups: readonly SkillGroupNode[];
  readonly skills: readonly SkillSummary[];
}

export interface BuildSkillGroupTreeOptions {
  readonly skillRoots?: readonly string[];
}

interface InternalGroupData {
  readonly path: string;
  readonly label: string;
  readonly directSkills: Map<string, SkillSummary>;
  readonly childPaths: Set<string>;
}

export function buildSkillGroupTree(
  skills: readonly SkillSummary[],
  options: BuildSkillGroupTreeOptions = {},
): SkillGroupNode {
  const groupsMap = new Map<string, InternalGroupData>();
  const topLevelPaths = new Set<string>();

  const getOrCreateGroup = (groupPath: string): InternalGroupData => {
    const existing = groupsMap.get(groupPath);
    if (existing !== undefined) return existing;

    const segments = groupPath.split('/').filter((s) => s.trim() !== '');
    const label = segments[segments.length - 1] ?? groupPath;

    const groupData: InternalGroupData = {
      path: groupPath,
      label,
      directSkills: new Map<string, SkillSummary>(),
      childPaths: new Set<string>(),
    };
    groupsMap.set(groupPath, groupData);

    if (segments.length > 1) {
      const parentPath = segments.slice(0, -1).join('/');
      const parentGroup = getOrCreateGroup(parentPath);
      parentGroup.childPaths.add(groupPath);
    } else {
      topLevelPaths.add(groupPath);
    }

    return groupData;
  };

  for (const skill of skills) {
    const assignedPaths = resolveGroupPathsForSkill(skill, options.skillRoots);
    for (const gPath of assignedPaths) {
      const groupNode = getOrCreateGroup(gPath);
      if (!groupNode.directSkills.has(skill.name)) {
        groupNode.directSkills.set(skill.name, skill);
      }
    }
  }

  const buildNode = (groupPath: string): SkillGroupNode => {
    const groupData = groupsMap.get(groupPath);
    if (groupData === undefined) {
      return {
        path: groupPath,
        label: groupPath,
        childGroups: [],
        skills: [],
      };
    }

    const sortedChildren = Array.from(groupData.childPaths)
      .map((cp) => buildNode(cp))
      .sort((a, b) => a.label.localeCompare(b.label));

    const sortedSkills = Array.from(groupData.directSkills.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    return {
      path: groupData.path,
      label: groupData.label,
      childGroups: sortedChildren,
      skills: sortedSkills,
    };
  };

  const topLevelNodes = Array.from(topLevelPaths)
    .map((tp) => buildNode(tp))
    .sort((a, b) => {
      // Put 'Uncategorized' at the end of top-level list
      if (a.path === 'Uncategorized') return 1;
      if (b.path === 'Uncategorized') return -1;
      return a.label.localeCompare(b.label);
    });

  return {
    path: '',
    label: 'Root',
    childGroups: topLevelNodes,
    skills: [],
  };
}

export function findGroupNode(
  node: SkillGroupNode,
  targetPath: string,
): SkillGroupNode | undefined {
  if (node.path === targetPath) return node;
  for (const child of node.childGroups) {
    const found = findGroupNode(child, targetPath);
    if (found !== undefined) return found;
  }
  return undefined;
}

function cleanGroupPath(rawPath: string): string | undefined {
  const segments = rawPath
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  return segments.length > 0 ? segments.join('/') : undefined;
}

function resolveGroupPathsForSkill(
  skill: SkillSummary,
  skillRoots: readonly string[] = [],
): readonly string[] {
  const resultGroups: string[] = [];

  // Rule 1: Explicit frontmatter `groups`
  if (Array.isArray(skill.groups) && skill.groups.length > 0) {
    for (const rawGroup of skill.groups) {
      if (typeof rawGroup !== 'string') continue;
      const cleanPath = cleanGroupPath(rawGroup);
      if (cleanPath !== undefined && !resultGroups.includes(cleanPath)) {
        resultGroups.push(cleanPath);
      }
    }
  }

  // Rule 2: Explicit `category` or `categories`
  const categoryCandidates: string[] = [];
  if (typeof skill.category === 'string' && skill.category.trim() !== '') {
    categoryCandidates.push(skill.category.trim());
  }
  if (Array.isArray(skill.categories)) {
    for (const cat of skill.categories) {
      if (typeof cat === 'string' && cat.trim() !== '') {
        categoryCandidates.push(cat.trim());
      }
    }
  }
  for (const cat of categoryCandidates) {
    const clean = cleanGroupPath(cat);
    if (clean !== undefined && !resultGroups.includes(clean)) {
      resultGroups.push(clean);
    }
  }

  // Rule 3: `tags` frontmatter field
  if (Array.isArray(skill.tags) && skill.tags.length > 0) {
    for (const tag of skill.tags) {
      if (typeof tag !== 'string') continue;
      const clean = cleanGroupPath(tag);
      if (clean !== undefined && !resultGroups.includes(clean)) {
        resultGroups.push(clean);
      }
    }
  }

  // Rule 4: Relative parent folder derivation
  const folderFallback = deriveFolderGroup(skill.path, skillRoots, skill.name);
  if (folderFallback !== undefined) {
    const clean = cleanGroupPath(folderFallback);
    if (clean !== undefined && !resultGroups.includes(clean)) {
      resultGroups.push(clean);
    }
  }

  // Rule 5: Hyphenated or underscore skill name namespace prefix fallback
  if (resultGroups.length === 0 && skill.name) {
    const namespaceGroup = deriveNamespaceGroup(skill.name);
    if (namespaceGroup !== undefined) {
      resultGroups.push(namespaceGroup);
    }
  }

  // Rule 6: Final fallback to Uncategorized
  if (resultGroups.length === 0) {
    return ['Uncategorized'];
  }

  return resultGroups;
}

function deriveNamespaceGroup(skillName: string): string | undefined {
  if (!skillName) return undefined;
  const parts = skillName.split('_').map((p) => p.trim()).filter((p) => p !== '');
  if (parts.length >= 2 && parts[0] !== undefined && parts[0].length > 0) {
    return parts[0];
  }
  return undefined;
}

function deriveFolderGroup(
  skillPath: string,
  skillRoots: readonly string[],
  skillName?: string,
): string | undefined {
  if (!skillPath) return undefined;
  const normalizedPath = path.resolve(skillPath);

  for (const root of skillRoots) {
    const normalizedRoot = path.resolve(root);
    if (normalizedPath.startsWith(normalizedRoot)) {
      const rel = path.relative(normalizedRoot, normalizedPath);
      const segments = rel.split(path.sep).filter((s) => s !== '' && s !== 'SKILL.md');
      if (segments.length >= 2) {
        // e.g. ["security", "owasp-audit"] -> "security"
        return segments[0];
      }
    }
  }

  // General fallback for paths containing /skills/ folder
  const parts = normalizedPath.split(path.sep);
  const skillsIdx = parts.lastIndexOf('skills');
  if (skillsIdx >= 0 && skillsIdx + 2 < parts.length) {
    const parentDir = parts[skillsIdx + 1];
    const itemDir = parts[skillsIdx + 2];
    if (
      parentDir !== undefined &&
      parentDir !== '' &&
      !parentDir.endsWith('.md') &&
      parentDir !== skillName &&
      itemDir !== undefined
    ) {
      return parentDir;
    }
  }

  return undefined;
}
