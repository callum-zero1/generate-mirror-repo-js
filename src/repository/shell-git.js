const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

let repoBaseDir;
let report = console.log;

function dirForRepoUrl(url) {
  // todo: add vendor namespace directory inside of repoBaseDir to path?
  if (url.slice(-4).toLowerCase() === '.git') {
    url = url.slice(0, url.length - 4);
  }
  if (url.slice(-1) === '/') {
    url = url.slice(0, url.length - 1);
  }
  return url.includes('/')
    ? url.slice(url.lastIndexOf('/'))
    : url;
}

function fullRepoPath(url) {
  return path.join(repoBaseDir, dirForRepoUrl(url));
}

function trimDir(dir) {
  return dir.slice(-1) === '/' ? dir.slice(0, dir.length -1) : dir;
}

/**
 * Ensure ref is secure to use as shell argument
 *
 * Escaping user supplied arguments is very hard, and since the ref names are based on what git repo branches exist,
 * this method will throw an exception if it determines anything fishy.
 *
 * @param {String} ref
 */
function validateRefIsSecure(ref) {
  if (ref.substring(0, 1) === '-' || ref.includes(' ') || ref.includes('`') || ref.includes('$')) {
    throw new Error(`Rejecting the ref "${ref}" as potentially insecure`)
  }
  return ref;
}

function validateBranchIsSecure(branch) {
  if (branch.substring(0, 1) === '-' || branch.includes(' ') || branch.includes('`') || branch.includes('$')) {
    throw new Error(`Rejecting the branch "${branch}" as potentially insecure`)
  }
  return branch;
}

function validateCommitMessageIsSecure(commitMessage) {
  if (commitMessage.substring(0, 1) === '-' || commitMessage.includes('`') || commitMessage.includes('$')) {
    throw new Error(`Rejecting the commit message "${commitMessage}" as potentially insecure`)
  }
  return commitMessage;
}

async function setCredentials(url, username = 'Mage-OS Mirror Repo', email = 'repo@mage-os.org') {
  const dir = fullRepoPath(url);

  await exec(`git config user.name "${username}"`, {cwd: dir});
  await exec(`git config user.email "${email}"`, {cwd: dir});
}

async function exec(cmd, options) {
  return new Promise((resolve, reject) => {
    const bufferBytes = 4 * 1024 * 1024; // 4M
    childProcess.exec(cmd, {maxBuffer: bufferBytes, ...(options || {})}, (error, stdout, stderr) => {
      if (error) {
        reject(`Error executing command: ${error.message}`);
      }
      if (stderr) {
        reject(`[error] ${stderr}`);
      }
      //console.log(`[${Math.ceil(stdout.length / 1024)}kb] ${cmd}`);
      resolve(stdout);
    });
  });
}

async function cloneRepo(url, dir, ref) {
  report(`Creating shallow ${url} clone of ${ref || 'all branches'} in "${dir.split('/').slice(-2).join('/')}"...`);

  if (! fs.existsSync(path.dirname(dir))) {
    fs.mkdirSync(path.dirname(dir), {recursive: true})
  }

  return exec(`git clone --depth 15 --quiet --no-single-branch ${url} ${dir}`);
}

async function currentTag(dir) {
  return (await exec(`git describe --tags --always`, {cwd: dir})).trim()
}

async function currentBranch(dir) {
  return (await exec(`git branch --show-current`, {cwd: dir})).trim()
}

async function currentCommit(dir) {
  return (await exec(`git log -1 --pretty=%H`, {cwd: dir})).trim();
}

async function initRepo(url, ref) {
  const dir = fullRepoPath(url);

  if (! fs.existsSync(dir)) {
    await cloneRepo(url, dir, ref);
  }
  if (ref) {
    if (await currentTag(dir) !== ref && await currentBranch(dir) !== ref && await currentCommit(dir) !== ref) {
      console.log(`checking out ${ref}`)
      await exec(`git checkout --force --quiet ${ref}`, {cwd: dir})
    }
  }
  
  return dir;
}


async function listFileNames(repoDir, path, excludes) {
  const excludeGit = `-not -path '.git' -not -path '.git/*'`;
  const excludeArgs = excludes.map(excludePath => {
    return excludePath.slice(-1) === '/'
      ? `-not -path '${excludePath}*'`
      : `-not -path '${excludePath}'`;
  }).join(' ');
  const out = await exec(`find '${path || '.'}' -type f ${excludeGit} ${excludeArgs}`, {cwd: repoDir});
  const files = out.trim().split("\n");
  return path === ''
    ? files.map(file => file.slice(2)) // cut off leading ./ if path is empty
    : files;
  
}

async function createBranch(url, branch) {
  const dir = fullRepoPath(url);

  if (branch) {
    if ((await exec(`git branch -l ${branch}`, {cwd: dir})).includes(branch)) {
      console.log(`checking out ${branch} (branch already existed)`)
      await exec(`git checkout --force --quiet ${branch}`, {cwd: dir})
      return dir;
    }

    console.log(`checking out ${branch} (creating new branch)`)
    await exec(`git checkout --force --quiet -b ${branch}`, {cwd: dir})
  }
  
  return dir;
}

async function deleteBranch(url, branchToDelete, force) {
  const dir = fullRepoPath(url);
  if (!(await exec(`git branch -l ${branchToDelete}`, {cwd: dir})).includes(branchToDelete)) {
    console.log(`Cannot delete branch ${branchToDelete}, it doesn't exist.`);
    return false;
  }

  if (force === true) {
    return await exec(`git branch -D ${branchToDelete}`, {cwd: dir});
  }

  return await exec(`git branch -d ${branchToDelete}`, {cwd: dir});
}

async function add(url, filepath) {
  const dir = fullRepoPath(url);
  return await exec(`git add ${filepath}`, {cwd: dir});
}

async function commit(url, message) {
  const dir = fullRepoPath(url);
  await setCredentials(url);
  return await exec(`git commit -m "${message}"`, {cwd: dir});
}

async function isDirTopLevel(filepath) {
  const topLevel = await exec(`git rev-parse --show-toplevel`, {cwd: filepath});
  if (topLevel.trim() === filepath) {
    return true;
  }

  return false;
}

module.exports = {
  async listFolders(url, pathInRepo, ref) {
    validateRefIsSecure(ref);
    const dir = await initRepo(url, ref);
    if (! fs.existsSync(path.join(dir, pathInRepo))) return [];
    const out = await exec(`ls -1 -d ${path.join(pathInRepo, '*/')}`, {cwd: dir});
    return out.trim().split("\n").map(trimDir);
  },
  async listFiles(url, pathInRepo, ref, excludes) {
    validateRefIsSecure(ref);
    const dir = await initRepo(url, ref);
    if (! fs.existsSync(path.join(dir, pathInRepo))) return [];
    const excludeStrings = excludes.map(exclude => typeof exclude === 'function' ? exclude(ref) : exclude).filter(exclude => exclude.length > 0);
    const fileNames = await listFileNames(dir, pathInRepo, excludeStrings || []);
    return fileNames.map(filepath => {
      const fullPath = path.join(dir, filepath);
      return {
        filepath,
        contentBuffer: fs.readFileSync(fullPath),
        isExecutable: 0o100755 === fs.statSync(fullPath).mode
      }
    });
  },
  async readFile(url, filepath, ref) {
    validateRefIsSecure(ref);
    const dir = await initRepo(url, ref);
    return fs.readFileSync(path.join(dir, filepath), 'utf8');
  },
  async lastCommitTimeForFile(url, filepath, ref) {
    validateRefIsSecure(ref);
    const dir = await initRepo(url, ref);
    const timestamp = exec(`git log -1 --pretty="format:%at" ${filepath}`, {cwd: dir})
    return new Date(parseInt(timestamp) * 1000); // convert seconds to JS timestamp ms
  },
  async listTags(url) {
    const dir = await initRepo(url);
    const out = await exec(`git tag`, {cwd: dir});
    return out.trim().split("\n");
  },
  async checkout(url, ref) {
    validateRefIsSecure(ref);
    return initRepo(url, ref);
  },
  async createBranch(url, branch) {
    validateBranchIsSecure(branch);
    return createBranch(url, branch);
  },
  async deleteBranch(url, branchToDelete, branchToSwitchTo, force) {
    validateBranchIsSecure(branchToDelete);
    validateBranchIsSecure(branchToSwitchTo);

    await createBranch(url, branchToSwitchTo);
    return deleteBranch(url, branchToDelete, force);
  },
  async createTagForRef(url, ref, tag, details) {
    validateRefIsSecure(ref);
    validateRefIsSecure(tag);
    const dir = await initRepo(url);
    const msg = await exec(`git tag -n ${tag}`, {cwd: dir});
    if (msg.trim().length === 0) {
      // Create tag if it doesn't exist
      await setCredentials(url);
      await exec(`git tag -a ${tag} ${ref} -m "Mage-OS Extra Ref"`, {cwd: dir});
    } else if (! msg.includes('Mage-OS Extra Ref')) {
      // Throw if the tag was not created by package generator
      throw (details || `Tag ${tag} already exists on repo ${url}`);
    }
  },
  async pull(url, ref) {
    validateRefIsSecure(ref);
    const dir = await initRepo(url, ref);
    await exec(`git pull --ff-only --quiet origin ${ref}`, {cwd: dir});
  },
  async add(url, filepath) {
    return add(url, filepath);
  },
  async commit(url, message) {
    validateCommitMessageIsSecure(message);
    return commit(url, message);
  },
  async isDirTopLevel(filepath) {
    return isDirTopLevel(filepath);
  },
  clearCache() {
    // noop
  },
  setStorageDir(dir) {
    repoBaseDir = dir;
  },
  testing: {
    dirForRepoUrl,
  }
}