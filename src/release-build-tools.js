const childProcess = require('child_process');
const {createHash} = require("crypto");
const {tmpdir} = require("os");
const {cwd, chdir} = require("process");
const repo = require("./repository");
const {accessSync, constants} = require("fs");
const fs = require("fs/promises");
const path = require("path");
const {readComposerJson, createMagentoCommunityEditionMetapackage} = require('./package-modules');


function fsExists(dirOrFile) {
  try {
    accessSync(dirOrFile, constants.R_OK);
    return true;
  } catch (exception) {
    return false;
  }
}


async function composerCreateMagentoProject(version) {
  console.log(`Determining upstream package versions for release ${version}...`);
  const workDir = `${tmpdir()}/workdir-${version}`;
  return new Promise((resolve, reject) => {
    if (fsExists(workDir)) {
      console.log(`Found existing installation at ${workDir}`)
      resolve(workDir)
    } else {
      const command = `composer create-project --ignore-platform-reqs --repository-url https://mirror.mage-os.org magento/project-community-edition ${workDir} ${version}`
      console.log(`Running ${command}`)
      const bufferBytes = 4 * 1024 * 1024; // 4M
      childProcess.exec(command, {maxBuffer: bufferBytes}, (error, stdout, stderr) => {
        //if (stderr && stderr.includes('Warning: The lock file is not up-to-date with the latest changes in composer.json')) stderr = '';
        if (stderr && stderr.includes('Generating autoload files')) stderr = '';
        if (error) {
          reject(`Error executing command: ${error.message}`)
        }
        if (stderr) {
          reject(`[error] ${stderr}`)
        }
        resolve(workDir)
      })
    }
  })
}

async function installSampleData(dir) {
  // @see \Magento\SampleData\Model\Dependency::SAMPLE_DATA_SUGGEST
  const SAMPLE_DATA_SUGGEST = 'Sample Data version:';
  const listCommand = `composer suggests --all`
  const bufferBytes = 4 * 1024 * 1024; // 4M
  const output = await (new Promise((resolve, reject) => {
    childProcess.exec(listCommand, {maxBuffer: bufferBytes, cwd: dir}, (error, stdout, stderr) => {
      if (error) {
        reject(`Error executing command: ${error.message}`)
      }
      if (stderr) {
        reject(`[error] ${stderr}`)
      }
      resolve(stdout.trim())
    })
  }))
  const packages = output.split("\n").filter(line => line.includes(SAMPLE_DATA_SUGGEST)).map(line => {
    // A line looks like (without the quotes):
    // " - magento/module-bundle-sample-data: Sample Data version: 100.4.*"
    const re = new RegExp(`^.+(?<package>magento\\/[^:]+): ${SAMPLE_DATA_SUGGEST}.*?(?<version>\\d.*)$`)
    return line.replace(re, '$<package>:$<version>')
  })
  return packages.length === 0
    ? true
    : new Promise((resolve, reject) => {
      const installCommand = `composer require --ignore-platform-reqs "${packages.join('" "')}"`
      console.log(`Installing sample data packages`)
      childProcess.exec(installCommand, {maxBuffer: bufferBytes, cwd: dir}, (error, stdout, stderr) => {
        if (stderr && stderr.includes('Generating autoload files')) stderr = '';
        if (error) {
          reject(`Error executing command: ${error.message}`)
        }
        if (stderr) {
          reject(`[error] ${stderr}`)
        }
        resolve(true)
      })
    })
}

async function getInstalledPackageMap(dir) {
  const command = `composer show --format=json`
  const bufferBytes = 4 * 1024 * 1024; // 4M
  const output = await (new Promise((resolve, reject) => {
    childProcess.exec(command, {maxBuffer: bufferBytes, cwd: dir}, (error, stdout, stderr) => {
      if (error) {
        reject(`Error executing command: ${error.message}`)
      }
      if (stderr) {
        reject(`[error] ${stderr}`)
      }
      resolve(stdout)
    })
  }))
  return JSON.parse(output).installed.reduce((map, installedPackage) => {
    map[installedPackage.name] = installedPackage.version
    return map;
  })
}

function validateVersionString(version, name) {
  const options = [
    /^[0-9]+\.[0-9]+(-[a-z][a-z0-9.]*)?$/, // e.g, 1.0, 1.2-beta, 2.4-p2
    /^[0-9]+\.[0-9]+\.[0-9]+(-[a-z][a-z0-9.]*)?$/ // e.g. 1.0.0, 1.2.1-alpha, 1.2.2-patch2
  ]
  if (options.map(re => version.match(re)).filter(v => v !== null).length === 0) {
    throw new Error(`${name || 'Version'} "${version}" is not a valid version (X.Y.Z[-suffix]).`)
  }
}

function setMageOsVendor(packageName) {
  return packageName.replace(/^magento\//, 'mage-os/')
}

function updateMapFromMagentoToMageOs(obj) {
  const packageNames = Object.keys(obj)
  return packageNames.reduce((acc, pkg) => Object.assign(acc, {[setMageOsVendor(pkg)]: obj[pkg]}), {})
}

function updateComposerDepsFromMagentoToMageOs(composerConfig) {
  composerConfig.name = setMageOsVendor(composerConfig.name)
  for (const dependencyType of ['require', 'require-dev', 'suggest']) {
    composerConfig[dependencyType] && (composerConfig[dependencyType] = updateMapFromMagentoToMageOs(composerConfig[dependencyType]))
  }
}

function setMageOsDependencyVersion(obj, dependencyType, releaseVersion) {
  const mageOsPackage = /^mage-os\//
  const packageNames = Object.keys(obj)
  packageNames.forEach(packageName => {
    if (packageName.match(mageOsPackage)) {
      obj[packageName] = dependencyType === 'suggest' && packageName.endsWith('-sample-data')
        ? `Sample Data version: ${releaseVersion}`
        : releaseVersion;
    }
  })
  return obj
}

function updateComposerDepsVersionForMageOs(composerConfig, releaseVersion) {
  for (const dependencyType of ['require', 'require-dev', 'suggest']) {
    composerConfig[dependencyType] && (composerConfig[dependencyType] = setMageOsDependencyVersion(composerConfig[dependencyType], dependencyType, releaseVersion))
  }
}

function updateComposerConfigFromMagentoToMageOs(composerConfig, releaseVersion, replaceVersionMap) {
  composerConfig.version = releaseVersion
  if (replaceVersionMap[composerConfig.name]) {
    composerConfig.replace = {[composerConfig.name]: replaceVersionMap[composerConfig.name]}
  }
  composerConfig.name = setMageOsVendor(composerConfig.name)
  updateComposerDepsFromMagentoToMageOs(composerConfig)
  updateComposerDepsVersionForMageOs(composerConfig, releaseVersion)
}

async function prepPackageForRelease({label, dir}, repoUrl, ref, releaseVersion, replaceVersionMap, workingCopyPath) {
  console.log(`\nPreparing ${label}`);

  const composerConfig = JSON.parse(await readComposerJson(repoUrl, dir, ref))
  updateComposerConfigFromMagentoToMageOs(composerConfig, releaseVersion, replaceVersionMap)

  // write composerJson to file in repo
  const file = path.join(workingCopyPath, dir, 'composer.json');
  await fs.writeFile(file, JSON.stringify(composerConfig, null, 2), 'utf8')

  console.log(`Adding composer.json to Git commit`);
  await repo.add(repoUrl, path.join(dir, 'composer.json'));
}


module.exports = {
  validateVersionString,
  async getPackageVersionMap(releaseVersion) {
    const dir = await composerCreateMagentoProject(releaseVersion)
    await installSampleData(dir)
    return getInstalledPackageMap(dir)
  },
  async prepRelease(releaseVersion, instruction, options) {
    console.log(`\nPrepping release of: ${instruction.repoUrl}`)
    const {replaceVersionMap} = options
    const {ref, repoUrl} = instruction

    const workingCopyPath = await repo.checkout(repoUrl, ref)

    const workBranch = `work-in-progress-release-prep-${releaseVersion}`;
    await repo.createBranch(repoUrl, workBranch, ref);

    for (const packageDirInstruction of (instruction.packageDirs || [])) {
      const childPackageDirs = await fs.readdir(path.join(workingCopyPath, packageDirInstruction.dir));

      for (let childPackageDir of childPackageDirs) {
        // Add trailing slash to our dir, so it matches excludes strings.
        if ((packageDirInstruction.excludes || []).includes(childPackageDir + path.sep)) {
          // Skip directory
          continue;
        }

        const workingChildPackagePath = path.join(workingCopyPath, packageDirInstruction.dir, childPackageDir);

        if (!(await fs.lstat(workingChildPackagePath)).isDirectory()) {
          // Not a directory, skip
          continue;
        }

        const childPackageFiles = await fs.readdir(workingChildPackagePath);
        if (!childPackageFiles.includes('composer.json')) {
          throw new Error(`Error: ${workingChildPackagePath} doesn\'t contain a composer.json! Please add to excludes in config.`);
        }

        childPackageDir = path.join(packageDirInstruction.dir, childPackageDir);
        const composerJson = JSON.parse(await readComposerJson(repoUrl, childPackageDir, workBranch));

        const instruction = {
          'label': `${composerJson.name} (part of ${packageDirInstruction.label})`,
          'dir': childPackageDir
        }
        await prepPackageForRelease(instruction, repoUrl, workBranch, releaseVersion, replaceVersionMap, workingCopyPath);
      }
    }

    for (const individualInstruction of (instruction.packageIndividual || [])) {
      await prepPackageForRelease(individualInstruction, repoUrl, workBranch, releaseVersion, replaceVersionMap, workingCopyPath);
    }

    for (const packageDirInstruction of (instruction.packageMetaFromDirs || [])) {
      // todo: prep meta package from dir
    }

    if (instruction.magentoCommunityEditionProject) {
      // todo: prep project meta package
    }

    if (instruction.magentoCommunityEditionMetapackage) {

      await createMagentoCommunityEditionMetapackage(repoUrl, workBranch, {
        release: releaseVersion,
        vendor: 'mage-os',
        dependencyVersions: {'*': releaseVersion},
        transform: {
          'mage-os/product-community-edition': [
            (composerConfig) => {
              updateComposerConfigFromMagentoToMageOs(composerConfig, releaseVersion, replaceVersionMap)
              return composerConfig
            }
          ]
        }
      })
    }

    console.log(`Committing`);
    await repo.commit(repoUrl, `Mage-OS Release ${releaseVersion}`);
  
    console.log(`Tagging at version: ${releaseVersion}`);
    await repo.createTagForRef(repoUrl, workBranch, releaseVersion);

    console.log(`Deleting branch: ${workBranch}`);
    await repo.deleteBranch(repoUrl, workBranch, ref, true);
  
    console.log(`Pushing`);
    // todo: push tag
    // need to setup forks of my own to test this.
  }
}
