const {knex} = require('../util/database').connect();
import _ from 'lodash';
import {deepChangeKeyCase} from '../util';

function getTeams(opts) {
  const isBanned = opts.client && !!opts.client.isBanned;

  let sqlString = `
    SELECT teams.id, teams.name, teams.image_path,
      SUM(COALESCE(action_types.value, 0)) AS score,
      cities.id AS city
    FROM teams
    LEFT JOIN actions ON teams.id = actions.team_id ${isBanned ? '' : 'AND NOT actions.is_banned'}
    LEFT JOIN action_types ON actions.action_type_id = action_types.id
    JOIN cities ON cities.id = teams.city_id
  `;

  let params = [];
  let whereClauses = [];

  if (opts.city) {
    whereClauses.push('cities.id = ?');
    params.push(opts.city);
  }

  if (whereClauses.length > 0) {
    sqlString += ` WHERE ${ whereClauses.join(' AND ')}`;
  }

  sqlString += `
    GROUP BY teams.id, teams.name, cities.id
    ORDER BY score DESC, teams.id
  `;

  return knex.raw(sqlString, params)
  .then(result => {
    return _.map(result.rows, row => deepChangeKeyCase(row, 'camelCase'));
  });
}

export {
  getTeams
};
