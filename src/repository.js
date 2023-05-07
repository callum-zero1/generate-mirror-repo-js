const path = require("path");

// Choose git backend implementation
//const git = require('./repository/pure-js-git');
const git = require('./repository/shell-git');

let repoBaseDir = path.join(process.cwd(), 'repositories');

git.setStorageDir(repoBaseDir)

module.exports = {
  async listFolders(url, path, ref) {
    return git.listFolders(url, path, ref);
  },
  async listFiles(url, path, ref, excludes) {
    return git.listFiles(url, path, ref, excludes)
  },
  async readFile(url, filepath, ref) {
    return git.readFile(url, filepath, ref)
  },
  async lastCommitTimeForFile(url, filepath, ref) {
    return git.lastCommitTimeForFile(url, filepath, ref)
  },
  async listTags(url) {
    return git.listTags(url)
  },
  async checkout(url, ref) {
    return git.checkout(url, ref);
  },
  async pull(url, ref) {
    return git.pull(url, ref);
  },
  async createTagForRef(url, ref, tag, details) {
    return git.createTagForRef(url, ref, tag, details)
  },
  async createBranch(url, branch) {
    return git.createBranch(url, branch)
  },
  async deleteBranch(url, branchToDelete, branchToSwitchTo, force) {
    return git.deleteBranch(url, branchToDelete, branchToSwitchTo, force)
  },
  async add(url, filepath) {
    return git.add(url, filepath);
  },
  async commit(url, message) {
    return git.commit(url, message);
  },
  async isDirTopLevel(filepath) {
    return git.isDirTopLevel(filepath);
  },
  clearCache() {
    git.clearCache()
  },
  setStorageDir(dir) {
    git.setStorageDir(dir);
  }
}