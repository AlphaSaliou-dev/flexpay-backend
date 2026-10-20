const express = require('express');
const { requireAuth } = require('../../middlewares/requireAuth');
const { upload } = require('./upload.middleware');
const controller = require('./files.controller');

const router = express.Router();

router.use(requireAuth);

// multipart/form-data, champ "file" + query ?purpose=KYC_ID_DOCUMENT
router.post('/', upload.single('file'), controller.uploadFile);
router.get('/:id', controller.getFile);

module.exports = router;
