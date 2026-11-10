/**
 * jQuery.deparam - The opposite of jQuery param. Creates an object of query string parameters.
 */
(function ($) {
  $.deparam =
    $.deparam ||
    function (uri) {
      if (uri === undefined) {
        uri = window.location.search;
      }
      var queryString = {};
      uri.replace(new RegExp('([^?=&]+)(=([^&#]*))?', 'g'), function ($0, $1, $2, $3) {
        queryString[$1] = decodeURIComponent(($3 || '').replace(/\+/g, '%20'));
      });
      return queryString;
    };
})(jQuery);
