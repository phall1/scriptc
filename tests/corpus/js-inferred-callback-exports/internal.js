export const toDate = value => new Date(value);
export default Object.assign(function(value) { return value + 1; }, {
  fromState(value) { return value - 1; },
});
