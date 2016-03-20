import _ from 'lodash';
const logger = require('../util/logger')(__filename);
const {knex} = require('../util/database').connect();
import {createFeedItem} from './feed-core';
import {markAsAggregated} from './action-core';

function queryStats() {
  let sqlString = `SELECT
      actions.id as id,
      actions.location as location,
      actions.aggregated as aggregated,
      action_types.code as action_type_code,
      users.id as user_id,
      users.name as user_name,
      teams.id as team_id,
      teams.name as team_name
    FROM actions
    JOIN action_types ON action_types.id = actions.action_type_id
    JOIN users ON users.id = actions.user_id
    JOIN teams ON teams.id = actions.team_id
    WHERE action_types.code = 'BEER'
    ORDER BY id`;

  return knex.raw(sqlString)
    .then(result => {
      const rows = result.rows;

      const stats = buildStats(rows);

      return stats;
    });
}

function buildStats(rows) {
  const getStats = function(stats, key, name) {
    const existing = stats[key];
    if (existing) {
      return existing;
    }

    const newStats = {
      name: name,
      beersAggregated: 0,
      newBeers: 0,
      newActions: []
    };

    stats[key] = newStats;
    return newStats;
  }

  const teamStats = {};
  const userStats = {};

  rows.forEach(row => {
    const team = getStats(teamStats, row.team_id, row.team_name);
    const user = getStats(userStats, row.user_id, row.user_name);

    if (row.aggregated) {
      team.beersAggregated++;
      user.beersAggregated++;
    } else {
      team.newBeers++;
      user.newBeers++;

      team.newActions.push(row);
      user.newActions.push(row);
    }
  });

  return {
    teamStats,
    userStats
  };
}

function handleAction(action, trx) {
  if (action.type === 'IMAGE' || action.type === 'TEXT') {
    return createFeedItem(action, trx)
      .then(() => markAsAggregated(action.id, trx));
  }

  return Promise.resolve();
}

function feedItemParam(action, text) {
  return {
    location: {
      latitude: action.location.x,
      longitude: action.location.y
    },
    text: text,
    type: 'TEXT'
  }
}

function integerDivide(num, denominator) {
  return Math.floor(num / denominator);
}

function createFeedItemForUser(feedItem, userId, newActions) {
  const maxId = _.last(newActions).id;

  return knex.transaction(function(trx) {
    return createFeedItem(feedItem, trx)
      .then(() => {
        return trx('actions')
          .update('aggregated', true)
          .where('id', '<=', maxId)
          .andWhere('aggregated', false)
          .andWhere('user_id', userId);
      });
  });
}

function createFeedItemForTeam(feedItem, teamId, newActions) {
  const maxId = _.last(newActions).id;

  return knex.transaction(function(trx) {
    return createFeedItem(feedItem, trx)
      .then(() => {
        return trx('actions')
          .update('aggregated', true)
          .where('id', '<=', maxId)
          .andWhere('aggregated', false)
          .andWhere('team_id', teamId);
      });
  });
}

function createBeerAggregates(stats) {
  const feedItemsToCreate = [];

  _.forEach(stats.userStats, (userStats, userId) => {
    if (userStats.beersAggregated === userStats.newBeers) {
      return;
    }

    const username = userStats.name;
    const beersBefore = userStats.beersAggregated;
    const beersAfter  = beersBefore + userStats.newBeers;
    let feedItem;

    if (beersBefore === 0) {
      const text = `${ username } starts wappu! Congratulations on the first mead!`;
      feedItem = feedItemParam(userStats.newActions[0], text);
    }
    else if (integerDivide(beersBefore, 100) !== integerDivide(beersAfter, 100)) {
      const text = `Such wow. ${ username } has had already ${ integerDivide(beersAfter, 100) * 100 } meads.`;
      const idx = 100 - beersBefore % 100;
      feedItem = feedItemParam(userStats.newActions[idx - 1], text);
    }

    if (feedItem) {
      feedItemsToCreate.push(
        createFeedItemForUser(feedItem, userId, userStats.newActions)
      )
    }
  });

  _.forEach(stats.teamStats, (teamStats, teamId) => {
    if (teamStats.beersAggregated === teamStats.newBeers) {
      return;
    }

    const name = teamStats.name;
    const beersBefore = teamStats.beersAggregated;
    const beersAfter  = beersBefore + teamStats.newBeers;
    let feedItem;

    if (beersBefore === 0) {
      const text = `${ name } starts wappu! Congratulations on the first mead!`;
      feedItem = feedItemParam(teamStats.newActions[0], text);
    }
    else if (integerDivide(beersBefore, 100) !== integerDivide(beersAfter, 100)) {
      const text = `Such wow. ${ name } has had already ${ integerDivide(beersAfter, 100) * 100 } meads.`;
      const idx = 100 - beersBefore % 100;
      feedItem = feedItemParam(teamStats.newActions[idx - 1], text);
    }

    if (feedItem) {
      feedItemsToCreate.push(
        createFeedItemForTeam(feedItem, teamId, teamStats.newActions)
      )
    }
  });

  return Promise.all(feedItemsToCreate);
}

function aggregate() {
  // TODO: It's suboptimal to query all actions on every poll.
  // Should use caching here.
  queryStats()
    .then(createBeerAggregates);
}

let isRunning = false;

function start() {
  if (isRunning) {
    throw new Error("Already running");
  }

  isRunning = true;

  function aggregateInterval() {
    try {
      aggregate();
    } catch (error) {
      logger.error(error);
    }

    setInterval(aggregateInterval, 60 * 1000);
  }

  aggregateInterval();
}

export {
  start,
  handleAction
};
