const core = require("@actions/core");
const github = require("@actions/github");
const { App } = require("octokit");

const TARGET_OWNER = process.env.TARGET_OWNER;
const TARGET_REPO = process.env.TARGET_REPO;

const USERNAME_REGEX = /(?<=@)[a-z0-9-]+/i;

async function checkCollaborators(octokit, username) {
  let returnVal = "not a collaborator";
  try {
    const response = await octokit.rest.repos.checkCollaborator({
      owner: TARGET_OWNER,
      repo: TARGET_REPO,
      username,
    });
    if (response) {
      console.log("it is a response");
      if (response.status == 204) {
        returnVal = "already collaborator";
      } else {
        returnVal = "not collaborator";
      }
    }
  } catch (err) {
    return err;
  }
  return returnVal;
}

// Utility function to wait for a specified duration (in seconds)
function waitForRateLimitReset(durationInSeconds) {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve();
    }, durationInSeconds * 1000);
  });
}

async function addCollaborator(octokit, username) {
  try {
    await octokit.rest.repos.addCollaborator({
      owner: TARGET_OWNER,
      repo: TARGET_REPO,
      username,
      permission: 'read'
    });
  } catch (error) {
    if (error.status === 403 && error.headers['x-ratelimit-remaining'] === '0') {
      // Rate limit exceeded, wait for reset and retry
      const rateLimitResetTime = error.headers['x-ratelimit-reset'];
      const currentTime = Math.floor(Date.now() / 1000);
      const waitTimeInSeconds = rateLimitResetTime - currentTime;
      console.log(`Rate limit exceeded. Waiting for ${waitTimeInSeconds} seconds before retrying.`);
      await waitForRateLimitReset(waitTimeInSeconds);
      // Retry the request after waiting
      return addCollaborator(octokit, username);
    } else {
      console.log(`ERROR: ${error.message} occurred at ${error.fileName}: ${error.lineNumber}`);
    }
  }
}

async function addComment(octokit, owner, repo, issueNumber, comment) {
  await octokit.rest.issues.createComment({owner, repo, issue_number: issueNumber, body: comment});
}

async function closeIssue(octokit, owner, repo, issueNumber) {
  await octokit.rest.issues.update({owner, repo, issue_number: issueNumber, state: "closed"});
}

async function addLabel(octokit, owner, repo, issueNumber, label) {
  await octokit.rest.issues.addLabels({owner, repo, issue_number: issueNumber, labels: [label]});
}

async function run() {
  try {
    // create Octokit client
    const app = new App({
      appId: process.env.APP_ID,
      // https://github.com/octokit/auth-app.js/issues/465
      privateKey: process.env.PRIVATE_KEY.replace(/\\n/g, '\n'),
    });
    const octokit = await app.getInstallationOctokit(process.env.INSTALLATION_ID);

    // get comment
    const {title: issueTitle, number: issueNumber} = github.context.payload.issue;
    const workflowRepo = github.context.payload.repository.name;
    const workflowOwner = github.context.payload.repository.owner.login;

    const requesterUsername = issueTitle.match(USERNAME_REGEX)[0];

    console.log(`Parsed event values:\n\tRepo: ${TARGET_REPO}\n\tUsername of commenter: ${requesterUsername}\n\tRepo Owner: ${TARGET_OWNER}`);

    // check to make sure commenter is not owner (gives big error energy)
    if (requesterUsername == TARGET_OWNER) {
      console.log("Commenter is the owner of this repository; exiting.");
      process.exit(0);
    }

    const isUserCollaborator = await checkCollaborators(octokit, requesterUsername);

    if (isUserCollaborator.status == 404) {
      await addCollaborator(octokit, requesterUsername);
      // add comment to issue
      const comment = `@${requesterUsername} has been added as a member of this repository. Please check your email or notifications for an invitation.`;
      const label = "collaborator added";
      await addComment(octokit, workflowOwner, workflowRepo, issueNumber, comment);
      // add label to issue
      await addLabel(octokit, workflowOwner, workflowRepo, issueNumber, label);
      // close issue
      await closeIssue(octokit, workflowOwner, workflowRepo, issueNumber);
    } else if (isUserCollaborator == "already collaborator") {
      const comment = `@${requesterUsername} is already a member of this repository.`;
      const label = "duplicate request";
      await addComment(octokit, workflowOwner, workflowRepo, issueNumber, comment);
      // add label to issue
      await addLabel(octokit, workflowOwner, workflowRepo, issueNumber, label);
      await closeIssue(octokit, workflowOwner, workflowRepo, issueNumber);
    }
  } catch (error) {
    console.log("Full error: " + error);
    core.setFailed(error.message);
  }
}

run();
