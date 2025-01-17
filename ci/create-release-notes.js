const path = require('path')
const fs = require('fs');

const { Octokit } = require('@octokit/rest');

const util = require('./utils');
const basePath = path.join(__dirname, '..');

const token = process.env['GH_TOKEN'];
const branch = process.env['branch'];

if (!token) {
    throw new util.CreateReleaseError('GH_TOKEN is not defined');
}

if (!branch) {
    throw new util.CreateReleaseError('branch is not defined');
}

const octokit = new Octokit({ auth: token });

const OWNER = 'microsoft';
const REPO = 'typed-rest-client';

/**
 * The function looks for the date of the commit where the package version was bumped
 * @param {String} package - name of the package 
 */
async function getPreviousReleaseDate() {
    const packagePath =  path.join(basePath, 'package.json');
    const verRegExp = /"version":/;

    function getHashFromVersion(verRegExp, ignoreHash) {
        let blameResult = ''
        if (ignoreHash) {
            blameResult = util.run(`git blame -w --ignore-rev ${ignoreHash} -- ${packagePath}`);
        } else {
            blameResult = util.run(`git blame -w -- ${packagePath}`);
        }
        const blameLines = blameResult.split('\n');
        const blameLine = blameLines.find(line => verRegExp.test(line));
        const commitHash = blameLine.split(' ')[0];
        return commitHash;
    }

    const currentHash = getHashFromVersion(verRegExp);
    console.log(`Current version change is ${currentHash}`);
    const prevHash = getHashFromVersion(verRegExp, currentHash);
    console.log(`Previous version change is ${prevHash}`);

    const date = await getPRDateFromCommit(prevHash);
    console.log(`Previous version change date is ${date}`);
    return date;
}


/**
 * Function to get the PR date from the commit hash
 * @param {string} sha1 - commit hash
 * @returns {Promise<string>} - date as a string with merged PR
 */
async function getPRDateFromCommit(sha1) {
    const response = await octokit.request('GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls', {
        owner: OWNER,
        repo: REPO,
        commit_sha: sha1,
        headers: {
          'X-GitHub-Api-Version': '2022-11-28'
        }
    });

    if (!response.data.length) {
        throw new Error(`No PRs found for commit ${sha1}`);
    }

    return response.data[0].merged_at;
} 

/**
 * Function to get the PR from the branch started from date
 * @param {string} branch - Branch to check for PRs
 * @param {string} date - Date since which to check for PRs
 * @returns {Promise<*>} - PRs merged since date
 */
async function getPRsFromDate(branch, date) {
    const PRs = [];
    let page = 1;
    try {
        while (true) {
            const results = await octokit.search.issuesAndPullRequests({
                q: `type:pr+is:merged+repo:${OWNER}/${REPO}+base:${branch}+merged:>${date}`,
                order: 'asc',
                sort: 'created',
                per_page: 100,
                page
            });

            page++;
            if (results.data.items.length == 0) break;

            PRs.push(...results.data.items);
        }

        return PRs;
    } catch (e) {
        throw new Error(e.message);
    }
}

/**
 * Function that create a release notes + tag for the new release
 * @param {string} releaseNotes - Release notes for the new release
 * @param {string} version - Version of the new release
 * @param {string} releaseBranch - Branch to create the release on
 */
async function createRelease(releaseNotes, version, releaseBranch) {
    const name = `Release v${version}`;
    const tagName = `v${version}`;
    console.log(`Creating release ${tagName} on ${releaseBranch}`);

    const newRelease = await octokit.repos.createRelease({
        owner: 'DmitriiBobreshev' || OWNER,
        repo: REPO,
        tag_name: tagName,
        name: name,
        body: releaseNotes,
        target_commitish: releaseBranch,
        generate_release_notes: false
    });

    console.log(`Release ${tagName} created`);
    console.log(`Release URL: ${newRelease.data.html_url}`);
}

/**
 * Function to verify that the new release tag is valid.
 * @param {string} newRelease  - Sprint version of the checked release
 * @returns {Promise<boolean>} - true - release exists, false - release does not exist
 */
async function isReleaseTagExists(version) {
    try {
        const tagName = `v${version}`;
        await octokit.repos.getReleaseByTag({
            owner: OWNER,
            repo: REPO,
            tag: tagName
        });

        return true;
    } catch (e) {
        return false
    }
}


async function main(branch) {
    try {
        const version = util.getCurrentPackageVersion();
        const isReleaseExists = await isReleaseTagExists(version);
        if (isReleaseExists) {
            console.log(`Release v${version} already exists`);
            return;
        }

        const date = await getPreviousReleaseDate();
        const data = await getPRsFromDate(branch, date);
        console.log(`Found ${data.length} PRs`);

        const changes = util.getChangesFromPRs(data);
        if (!changes.length) {
            console.log(`No changes found for ${branch}`);
            return;
        }

        const releaseNotes = changes.join('\n');
        await createRelease(releaseNotes, version, branch);
    } catch (e) {
        throw new util.CreateReleaseError(e.message);
    }
}

main('master');