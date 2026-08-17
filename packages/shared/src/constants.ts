export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  'vendor',
  'target',
  '.turbo',
  '__pycache__',
  '.cache',
  'out',
  '.vercel',
  '.svelte-kit',
]);

export const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.rb': 'ruby',
  '.php': 'php',
  '.cs': 'csharp',
  '.cpp': 'cpp',
  '.c': 'c',
  '.h': 'c',
  '.hpp': 'cpp',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.xml': 'xml',
  '.html': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.sql': 'sql',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.env': 'dotenv',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.proto': 'protobuf',
  '.tf': 'terraform',
  '.hcl': 'hcl',
  '.prisma': 'prisma',
};

/** @deprecated use MAX_CHUNK_TOKENS for accurate LLM context budgeting */
export const MAX_CHUNK_CHARS = 2000;
export const MAX_CHUNK_TOKENS = 512;
export const CHUNK_OVERLAP_LINES = 5;
export const EMBEDDING_DIMENSIONS = 1536;

export const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.rb', '.php',
  '.cs', '.cpp', '.c', '.h', '.hpp', '.sh', '.bash',
]);

export const CONFIG_EXTENSIONS = new Set([
  '.json', '.yaml', '.yml', '.toml', '.env', '.xml',
  '.tf', '.hcl', '.prisma',
]);

export const MIGRATION_PATTERNS = [
  /migrations?\//i,
  /\d{4,}.*\.sql$/,
];
