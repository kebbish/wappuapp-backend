import _ from 'lodash';
const {knex} = require('../util/database').connect();
import {deepChangeKeyCase} from '../util';
import * as feedCore from './feed-core';
const requireEnvs = require('../util/require-envs');

requireEnvs(['MOOD_START_DATE', 'MOOD_END_DATE']);

function createOrUpdateMood(opts) {
  const upsertMoodSql = `
    WITH upsert AS
      (UPDATE
        wappu_mood
      SET
        rating = ?,
        description = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE
        user_id = ? AND created_at_coarse = CURRENT_DATE
      RETURNING
        *,
        false AS is_new
    ), inserted AS (
        INSERT INTO
          wappu_mood(user_id, rating, description)
        SELECT ?, ?, ? WHERE NOT EXISTS( SELECT * FROM upsert )
        RETURNING
          *,
          true AS is_new
    )
    SELECT *
    FROM upsert
    UNION ALL
    SELECT *
    FROM inserted;
  `;

  let params = [
    opts.rating, opts.description, opts.client.id,
    opts.client.id, opts.rating, opts.description
  ];

  return knex.transaction(trx =>
    trx.raw(upsertMoodSql, params)
      .then(result => {
        const mood = result.rows[0];

        if (mood.is_new && _hasDescription(mood)) {
          feedCore.createFeedItem(_feedTemplate(mood, opts));
        }

        return undefined;
      }));
}

function getMood(opts) {
  let params = [];
  let sqlFragments = [];
  let select = [];

  if (!opts.city && !opts.team) {
    params = [
      _getCityMoodParams(opts),
      _getTeamMoodParams(opts),
      _getPersonalMoodParams(opts),
    ];

    sqlFragments = [
      _getCityMoodSql(),
      _getTeamMoodSql(),
      _getPersonalMoodSql(),
    ];

    select = [
      'rating_city',
      'rating_team',
      'rating_personal',
    ];

  } else {
    if (opts.city) {
      params.push(_getCityMoodParams(opts));
      sqlFragments.push(_getCityMoodSql());
      select.push('rating_city');
    }

    if (opts.team) {
      params.push(_getTeamMoodParams(opts));
      sqlFragments.push(_getTeamMoodSql());
      select.push('rating_team');
    }
  }

  const sql = `
    SELECT
      date,
      ${ select.join(', ') }
    FROM (
      SELECT date::DATE
      FROM   generate_series(
        '${process.env.MOOD_START_DATE}'::DATE,
        '${process.env.MOOD_END_DATE}'::DATE,
        interval '1 day'
      ) date
    ) dates
    ${ sqlFragments.join(' ') }
    ORDER BY date ASC;
  `;

  return knex.transaction(trx =>
    trx.raw(sql, params)
      .then(result => _rowsToMoodObjects(result.rows)));
}

function _getCityId(opts) {
  if (opts.city) {
    return opts.city;
  } else {
    return knex.raw('(SELECT city_id FROM teams WHERE id = ?)', [opts.client.team]);
  }
}

function _getTeamId(opts) {
  if (opts.team) {
    return opts.team;
  } else {
    return opts.client.team;
  }
}

function _getCityMoodSql() {
  return `
    JOIN LATERAL (
      SELECT
        ROUND(AVG(wappu_mood.rating)::numeric, 4) AS rating_city
      FROM
        wappu_mood
      JOIN users ON users.id = wappu_mood.user_id
      JOIN teams ON teams.id = users.team_id
      WHERE teams.city_id = ? AND wappu_mood.created_at_coarse = date
    ) city_score ON true
  `;
}

function _getCityMoodParams(opts) {
  return _getCityId(opts);
}

function _getTeamMoodSql() {
  return `
    JOIN LATERAL (
      SELECT
        ROUND(AVG(wappu_mood.rating)::numeric, 4) AS rating_team
      FROM
        wappu_mood
      JOIN users ON users.id = wappu_mood.user_id
      WHERE users.team_id = ? AND date = wappu_mood.created_at_coarse
    ) team_score ON true
  `;
}

function _getTeamMoodParams(opts) {
  return _getTeamId(opts);
}

function _getPersonalMoodSql() {
  return `
    JOIN LATERAL (
      SELECT
        ROUND(AVG(wappu_mood.rating)::numeric, 4) AS rating_personal
      FROM
        wappu_mood
      WHERE
        wappu_mood.user_id = ? AND date = wappu_mood.created_at_coarse
    ) personal_score ON true
  `;
}

function _getPersonalMoodParams(opts) {
  return opts.client.id;
}

function _rowsToMoodObjects(rows) {
  return rows.map(row => deepChangeKeyCase(row, 'camelCase'));
}

function _feedTemplate(row, opts) {
  return {
    location: opts.location,
    user:  opts.client.uuid,
    type: 'TEXT',
    text: `${ opts.client.name }'s wappu vibe is ${ row.rating } - ${ _.trim(row.description) }`,
    client: opts.client,
  }
}

function _hasDescription(row) {
  return row.description && _.trim(row.description).length > 0;
}

export {
  createOrUpdateMood,
  getMood,
};