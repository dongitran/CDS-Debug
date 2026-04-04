service HealthService @(path: '/health') {
  function ping()   returns String;
  function status() returns {
    status  : String;
    uptime  : Integer;
    version : String;
  };
}
