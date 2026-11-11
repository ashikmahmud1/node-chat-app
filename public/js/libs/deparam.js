/**
 * jQuery.deparam - Parses URL query string parameters (jQuery 4.0.0 compatible).
 */
(function ($) {
  $.deparam =
    $.deparam ||
    function (uri) {
      var raw = uri === undefined ? window.location.search : String(uri);
      var queryString = {};
      if (typeof URLSearchParams !== 'undefined') {
        var cleaned = raw.charAt(0) === '?' ? raw.slice(1) : raw;
        var searchParams = new URLSearchParams(cleaned);
        searchParams.forEach(function (value, key) {
          queryString[key] = value;
        });
        return queryString;
      }
      raw.replace(new RegExp('([^?=&]+)(=([^&#]*))?', 'g'), function ($0, $1, $2, $3) {
        queryString[$1] = decodeURIComponent(($3 || '').replace(/\+/g, '%20'));
      });
      return queryString;
    };
})(jQuery);
