const express = require('express');
const { ZodError } = require('zod');
const { formatIssues } = require('../validation');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const envelope = (data = null, error = null) => ({ data, error });

function createPatientsRouter({ patients, log }) {
  const router = express.Router();

  const notFound = res => res.status(404).json(envelope(null, { code: 'NOT_FOUND', message: 'Patient not found' }));
  const validationFailed = (res, error) =>
    res.status(422).json(envelope(null, { code: 'VALIDATION_ERROR', message: 'Invalid patient data', details: formatIssues(error) }));

  router.param('id', (req, res, next, id) => {
    if (!UUID.test(id)) return res.status(400).json(envelope(null, { code: 'BAD_REQUEST', message: 'patient_id must be a UUID' }));
    next();
  });

  const requireObjectBody = (req, res, next) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json(envelope(null, { code: 'BAD_REQUEST', message: 'Request body must be a JSON object' }));
    }
    next();
  };

  router.get('/', (req, res) => {
    const { last_name, date_of_birth, phone_number } = req.query;
    res.json(envelope(patients.list({ last_name, date_of_birth, phone_number })));
  });

  router.get('/:id', (req, res) => {
    const patient = patients.get(req.params.id);
    return patient ? res.json(envelope(patient)) : notFound(res);
  });

  router.post('/', requireObjectBody, (req, res, next) => {
    try {
      const patient = patients.create(req.body);
      log('patient_created', { source: 'api', patient_id: patient.patient_id });
      res.status(201).location(`/patients/${patient.patient_id}`).json(envelope(patient));
    } catch (error) {
      if (error instanceof ZodError) return validationFailed(res, error);
      next(error);
    }
  });

  router.put('/:id', requireObjectBody, (req, res, next) => {
    try {
      const patient = patients.update(req.params.id, req.body);
      if (!patient) return notFound(res);
      log('patient_updated', { source: 'api', patient_id: patient.patient_id });
      res.json(envelope(patient));
    } catch (error) {
      if (error instanceof ZodError) return validationFailed(res, error);
      next(error);
    }
  });

  router.delete('/:id', (req, res) => {
    const result = patients.softDelete(req.params.id);
    if (!result) return notFound(res);
    log('patient_deleted', { source: 'api', patient_id: req.params.id });
    res.json(envelope(result));
  });

  return router;
}

module.exports = { createPatientsRouter, envelope };
