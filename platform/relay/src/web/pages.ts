import { Router } from 'express';
import { homeRouter } from './home.js';
import { landingPageRouter } from './landing.js';
import { downloadRouter } from './download.js';
import { authPagesRouter } from './authPages.js';
import { accountPageRouter } from './account.js';
import { profilePageRouter } from './profile.js';
import { supportPageRouter } from './support.js';
import { teamPageRouter } from './org.js';
import { invitePageRouter } from './invite.js';

// Aggregator only — the actual page handlers live in the sibling files above, split
// out of what used to be one large file (home/marketing, download, auth forms,
// account+billing, profile are different enough concerns to live separately).
const router = Router();
export const webRouter = router;

router.use(landingPageRouter);
router.use(homeRouter);
router.use(downloadRouter);
router.use(authPagesRouter);
router.use(accountPageRouter);
router.use(profilePageRouter);
router.use(supportPageRouter);
router.use(teamPageRouter);
router.use(invitePageRouter);
